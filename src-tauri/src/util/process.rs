//! Process spawn helpers (Windows console flash suppression, Linux host env).

use std::process::Command;

/// Prevent a brief console window when a GUI app spawns console tools on Windows
/// (`ffmpeg`, `powershell`, `nvidia-smi`, …). No-op on other platforms.
pub fn apply_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
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

    #[cfg(target_os = "linux")]
    #[test]
    fn apply_host_library_path_is_callable() {
        let mut cmd = Command::new("true");
        apply_host_library_path(&mut cmd);
    }
}
