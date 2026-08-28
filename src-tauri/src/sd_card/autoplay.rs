//! Suppress Windows Explorer AutoPlay when an SD / removable volume is inserted.
//!
//! While Aero Tandem Studio is running we:
//! 1. Answer `QueryCancelAutoPlay` on the main window (works when we are foreground).
//! 2. On SD detect: focus the app and close Explorer windows that opened on that drive.
//!
//! macOS / Linux: no-ops (Finder/file managers do not mirror this AutoPlay behavior).

use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use tauri::{AppHandle, Manager};

#[cfg(windows)]
use crate::sd_card::eject::windows_drive_letter;
use crate::storage::logging;
use crate::util::window_focus::focus_main_window;

static INSTALLED_HWND: AtomicIsize = AtomicIsize::new(0);
static QUERY_CANCEL_MSG: AtomicU32 = AtomicU32::new(0);

const SUBCLASS_ID: usize = 0xAE70_A070; // Aero AutoPlay

/// Install AutoPlay cancellation on the main window (Windows only).
pub fn install(app: &AppHandle) {
    #[cfg(windows)]
    {
        if let Err(e) = install_windows(app) {
            logging::warn("sd", format!("AutoPlay-Unterdrückung nicht aktiv: {e}"));
        } else {
            logging::info("sd", "Windows AutoPlay-Unterdrückung aktiv");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Remove the window subclass (call on exit).
pub fn uninstall() {
    #[cfg(windows)]
    {
        uninstall_windows();
    }
}

/// Bring the app to the front and dismiss Explorer windows for `drive` (e.g. `E:`).
pub fn on_sd_inserted(app: &AppHandle, drive: &str) {
    focus_main_window(app);

    #[cfg(windows)]
    {
        if let Some(letter) = windows_drive_letter(drive) {
            // Explorer may open slightly after our SD event — retry briefly.
            std::thread::spawn(move || {
                for delay_ms in [0u64, 400, 900, 1600] {
                    if delay_ms > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    }
                    close_explorer_windows_for_drive(letter);
                }
            });
        }
    }
    #[cfg(not(windows))]
    {
        let _ = drive;
    }
}

#[cfg(windows)]
fn install_windows(app: &AppHandle) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::UI::Shell::SetWindowSubclass;
    use windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Hauptfenster nicht gefunden".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("HWND nicht verfügbar: {e}"))?;

    let msg = unsafe { RegisterWindowMessageW(w!("QueryCancelAutoPlay")) };
    if msg == 0 {
        return Err("RegisterWindowMessage(QueryCancelAutoPlay) fehlgeschlagen".into());
    }
    QUERY_CANCEL_MSG.store(msg, Ordering::SeqCst);

    // Replace any previous install (e.g. hot-reload / re-init).
    uninstall_windows();

    let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
    if !ok.as_bool() {
        return Err("SetWindowSubclass fehlgeschlagen".into());
    }

    INSTALLED_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
    Ok(())
}

#[cfg(windows)]
fn uninstall_windows() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::RemoveWindowSubclass;

    let raw = INSTALLED_HWND.swap(0, Ordering::SeqCst);
    if raw == 0 {
        return;
    }
    let hwnd = HWND(raw as *mut std::ffi::c_void);
    unsafe {
        let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
    }
}

#[cfg(windows)]
unsafe extern "system" fn subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uid: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;

    let cancel_msg = QUERY_CANCEL_MSG.load(Ordering::SeqCst);
    if cancel_msg != 0 && msg == cancel_msg {
        // TRUE → cancel AutoPlay / do not open Explorer.
        return LRESULT(1);
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Close Explorer folder windows whose location is the given drive letter.
#[cfg(windows)]
fn close_explorer_windows_for_drive(letter: char) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let letter_upper = letter.to_ascii_uppercase();
    // LocationURL is typically file:///E:/ or file:///E:/DCIM …
    let script = format!(
        "$L='{letter_upper}'; \
         $sh=New-Object -ComObject Shell.Application; \
         @($sh.Windows()) | ForEach-Object {{ \
           try {{ \
             $u=[string]$_.LocationURL; \
             if(-not $u){{ return }}; \
             if($u -match (\"(?i)^file:///\"+$L+\"(:|/|%3[Aa])\")){{ $_.Quit() }} \
           }} catch {{}} \
         }}"
    );

    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(test)]
mod tests {
    fn location_matches_drive(url: &str, letter: char) -> bool {
        let letter = letter.to_ascii_uppercase();
        let lower = url.to_ascii_lowercase();
        let prefix_colon = format!("file:///{letter}:");
        let prefix_slash = format!("file:///{letter}/");
        let prefix_enc = format!("file:///{letter}%3a");
        lower.starts_with(&prefix_colon.to_ascii_lowercase())
            || lower.starts_with(&prefix_slash.to_ascii_lowercase())
            || lower.starts_with(&prefix_enc.to_ascii_lowercase())
    }

    #[test]
    fn matches_typical_explorer_urls() {
        assert!(location_matches_drive("file:///E:/", 'E'));
        assert!(location_matches_drive("file:///E:/DCIM", 'e'));
        assert!(location_matches_drive("file:///E%3A/DCIM", 'E'));
        assert!(!location_matches_drive("file:///C:/Windows", 'E'));
        assert!(!location_matches_drive("https://example.com", 'E'));
    }
}
