//! Bring the main window to the foreground (post-update restart, SD insert, etc.).

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, UserAttentionType};

const FOCUS_AFTER_UPDATE_MARKER: &str = ".focus_after_update";

fn marker_path_in(dir: &Path) -> PathBuf {
    dir.join(FOCUS_AFTER_UPDATE_MARKER)
}

pub fn focus_after_update_marker_path() -> Result<PathBuf, String> {
    crate::storage::app_config_dir()
        .map(|dir| marker_path_in(&dir))
        .map_err(|e| e.to_string())
}

/// Write marker before `update.install()` — survives process exit on Windows NSIS restart.
pub fn mark_focus_after_update() -> Result<(), String> {
    let path = focus_after_update_marker_path()?;
    mark_focus_after_update_at(path.parent().unwrap_or(Path::new("")))
}

fn mark_focus_after_update_at(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(marker_path_in(dir), b"1").map_err(|e| e.to_string())
}

/// Returns true if marker existed (and removes it).
pub fn consume_focus_after_update_marker() -> bool {
    match focus_after_update_marker_path() {
        Ok(path) => consume_focus_after_update_marker_at(path.parent().unwrap_or(Path::new(""))),
        Err(_) => false,
    }
}

fn consume_focus_after_update_marker_at(dir: &Path) -> bool {
    let path = marker_path_in(dir);
    if path.is_file() {
        let _ = fs::remove_file(path);
        true
    } else {
        false
    }
}

pub fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    if window.set_focus().is_err() {
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    }
}

/// If update marker present: consume and focus main window.
pub fn focus_main_window_if_update_restart(app: &AppHandle) -> bool {
    if !consume_focus_after_update_marker() {
        return false;
    }
    focus_main_window(app);
    true
}

/// Fallback when the frontend has not focused yet (e.g. slow WebView init).
pub fn schedule_focus_after_update_backup(app: AppHandle) {
    if !focus_after_update_marker_path()
        .map(|p| p.is_file())
        .unwrap_or(false)
    {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2000));
        let _ = focus_main_window_if_update_restart(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static TEST_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn test_lock() -> MutexGuard<'static, ()> {
        TEST_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn mark_and_consume_focus_marker() {
        let _guard = test_lock();
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!consume_focus_after_update_marker_at(dir.path()));
        mark_focus_after_update_at(dir.path()).expect("mark");
        assert!(marker_path_in(dir.path()).is_file());
        assert!(consume_focus_after_update_marker_at(dir.path()));
        assert!(!marker_path_in(dir.path()).exists());
        assert!(!consume_focus_after_update_marker_at(dir.path()));
    }
}
