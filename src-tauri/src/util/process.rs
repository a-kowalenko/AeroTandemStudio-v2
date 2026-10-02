//! Process spawn helpers (Windows console flash suppression, Linux host env).

use std::process::Command;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

/// Windows creation flags for background FFmpeg/ffprobe children.
/// `creation_flags` overwrites previous flags, so both bits must be set in one call.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const BACKGROUND_CREATION_FLAGS: u32 = CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS;

/// Unix `nice` increment for background children.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const BACKGROUND_NICE: i32 = 5;

/// Prevent a brief console window when a GUI app spawns console tools on Windows
/// (`ffmpeg`, `powershell`, `nvidia-smi`, …). No-op on other platforms.
pub fn apply_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Run the child below the app's priority so UI / WebView keep CPU time
/// (Windows `BELOW_NORMAL_PRIORITY_CLASS` + no console, Unix `nice +5`).
///
/// On Windows this sets the creation flags including `CREATE_NO_WINDOW`; do not call
/// [`apply_no_window`] afterwards (it would drop the priority bit).
pub fn apply_background_priority(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(BACKGROUND_CREATION_FLAGS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `nice` is async-signal-safe; the closure allocates nothing.
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc::nice(BACKGROUND_NICE);
                Ok(())
            });
        }
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        let _ = cmd;
    }
}

/// Spawn defaults for every FFmpeg / ffprobe child: no console window + background priority.
pub fn apply_ffmpeg_spawn_defaults(cmd: &mut Command) {
    apply_background_priority(cmd);
}

/// Make a child use distro libraries instead of AppImage / bundle `LD_LIBRARY_PATH`.
///
/// Tauri AppImages (linuxdeploy) prepend bundled glib/etc. System tools such as
/// `udisksctl` then fail with symbol errors, e.g.
/// `undefined symbol: g_once_init_leave_pointer`.
///
/// Restores `LD_LIBRARY_PATH_ORIG` when present (AppImage convention).
#[cfg(target_os = "linux")]
pub fn apply_host_library_path(cmd: &mut Command) {
    cmd.env_remove("LD_LIBRARY_PATH");
    cmd.env_remove("LD_PRELOAD");
    if let Some(orig) = std::env::var_os("LD_LIBRARY_PATH_ORIG") {
        if !orig.is_empty() {
            cmd.env("LD_LIBRARY_PATH", orig);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_no_window_is_callable() {
        let mut cmd = Command::new("true");
        apply_no_window(&mut cmd);
    }

    #[test]
    fn apply_ffmpeg_spawn_defaults_is_callable() {
        let mut cmd = Command::new("true");
        apply_ffmpeg_spawn_defaults(&mut cmd);
        let mut cmd = Command::new("true");
        apply_background_priority(&mut cmd);
    }

    #[test]
    fn background_flags_keep_no_window_and_below_normal() {
        assert_eq!(BACKGROUND_CREATION_FLAGS, 0x0800_4000);
        assert_ne!(BACKGROUND_CREATION_FLAGS & CREATE_NO_WINDOW, 0);
        assert_ne!(BACKGROUND_CREATION_FLAGS & BELOW_NORMAL_PRIORITY_CLASS, 0);
        assert!(BACKGROUND_NICE > 0);
    }

    #[cfg(unix)]
    #[test]
    fn background_child_still_runs() {
        let mut cmd = Command::new("true");
        apply_ffmpeg_spawn_defaults(&mut cmd);
        assert!(cmd.status().expect("spawn true").success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn apply_host_library_path_is_callable() {
        let mut cmd = Command::new("true");
        apply_host_library_path(&mut cmd);
    }
}
