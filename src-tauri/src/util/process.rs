//! Process spawn helpers (Windows console flash suppression).

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
