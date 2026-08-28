//! Bring the main window to the foreground (post-update restart, SD insert, etc.).

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, UserAttentionType};

const FOCUS_AFTER_UPDATE_MARKER: &str = ".focus_after_update";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PostUpdateMarker {
    #[serde(default)]
    pub version: String,
}

fn marker_path_in(dir: &Path) -> PathBuf {
    dir.join(FOCUS_AFTER_UPDATE_MARKER)
}

pub fn focus_after_update_marker_path() -> Result<PathBuf, String> {
    crate::storage::app_config_dir()
        .map(|dir| marker_path_in(&dir))
        .map_err(|e| e.to_string())
}

fn read_marker_at(dir: &Path) -> Option<PostUpdateMarker> {
    let path = marker_path_in(dir);
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "1" {
        return Some(PostUpdateMarker {
            version: String::new(),
        });
    }
    serde_json::from_str(trimmed).ok().or_else(|| {
        Some(PostUpdateMarker {
            version: trimmed.to_string(),
        })
    })
}

fn write_marker_at(dir: &Path, marker: &PostUpdateMarker) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_string(marker).map_err(|e| e.to_string())?;
    fs::write(marker_path_in(dir), body).map_err(|e| e.to_string())
}

/// Write marker before `update.install()` — survives process exit on restart.
pub fn mark_post_update_restart(version: &str) -> Result<(), String> {
    let path = focus_after_update_marker_path()?;
    mark_post_update_restart_at(
        path.parent().unwrap_or(Path::new("")),
        version.trim(),
    )
}

fn mark_post_update_restart_at(dir: &Path, version: &str) -> Result<(), String> {
    write_marker_at(
        dir,
        &PostUpdateMarker {
            version: version.to_string(),
        },
    )
}

/// Legacy name used before JSON marker (updater still calls through wrapper).
pub fn mark_focus_after_update() -> Result<(), String> {
    mark_post_update_restart("")
}

pub fn peek_post_update_marker() -> Option<PostUpdateMarker> {
    focus_after_update_marker_path()
        .ok()
        .and_then(|path| read_marker_at(path.parent().unwrap_or(Path::new(""))))
}

pub fn clear_post_update_marker() -> bool {
    match focus_after_update_marker_path() {
        Ok(path) => clear_post_update_marker_at(path.parent().unwrap_or(Path::new(""))),
        Err(_) => false,
    }
}

fn clear_post_update_marker_at(dir: &Path) -> bool {
    let path = marker_path_in(dir);
    if path.is_file() {
        let _ = fs::remove_file(path);
        true
    } else {
        false
    }
}

/// Returns true if marker existed (and removes it). Prefer `clear_post_update_marker`.
pub fn consume_focus_after_update_marker() -> bool {
    clear_post_update_marker()
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

/// If post-update marker present: focus main window (marker stays for UI hint).
pub fn focus_main_window_if_update_restart(app: &AppHandle) -> bool {
    if peek_post_update_marker().is_none() {
        return false;
    }
    focus_main_window(app);
    true
}

/// Fallback when the frontend has not focused yet (e.g. slow WebView init).
pub fn schedule_focus_after_update_backup(app: AppHandle) {
    if peek_post_update_marker().is_none() {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2000));
        if peek_post_update_marker().is_some() {
            focus_main_window(&app);
        }
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
    fn mark_peek_and_clear_json_marker() {
        let _guard = test_lock();
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(peek_post_update_marker_at(dir.path()).is_none());
        mark_post_update_restart_at(dir.path(), "0.4.0-beta.4").expect("mark");
        let peeked = peek_post_update_marker_at(dir.path()).expect("peek");
        assert_eq!(peeked.version, "0.4.0-beta.4");
        assert!(clear_post_update_marker_at(dir.path()));
        assert!(peek_post_update_marker_at(dir.path()).is_none());
    }

    #[test]
    fn legacy_byte_marker_still_peeks() {
        let _guard = test_lock();
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(marker_path_in(dir.path()), b"1").expect("write");
        let peeked = peek_post_update_marker_at(dir.path()).expect("peek");
        assert!(peeked.version.is_empty());
    }

    fn peek_post_update_marker_at(dir: &Path) -> Option<PostUpdateMarker> {
        read_marker_at(dir)
    }
}
