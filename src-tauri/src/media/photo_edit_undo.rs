//! First-generation undo for photo edits (rotate) on working copies.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use thiserror::Error;

static PHOTO_EDIT_UNDO: Lazy<Mutex<PhotoEditUndoState>> =
    Lazy::new(|| Mutex::new(PhotoEditUndoState::default()));

#[derive(Debug, Error)]
pub enum PhotoEditUndoError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
struct PhotoEditUndoEntry {
    restore_path: String,
    backup_path: PathBuf,
}

#[derive(Debug, Default)]
struct PhotoEditUndoState {
    by_key: HashMap<String, PhotoEditUndoEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UndoPhotoEditResult {
    pub restore_path: String,
}

fn norm_key(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

pub fn pre_edit_backup_path(photo_path: &str) -> PathBuf {
    let path = Path::new(photo_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("photo");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg");
    path.with_file_name(format!("{stem}.__pre_edit__.{ext}"))
}

fn lock_state() -> Result<std::sync::MutexGuard<'static, PhotoEditUndoState>, PhotoEditUndoError> {
    PHOTO_EDIT_UNDO
        .lock()
        .map_err(|_| PhotoEditUndoError::Message("photo edit undo lock poisoned".into()))
}

fn remove_backup_file(path: &Path) {
    let _ = fs::remove_file(path);
}

pub fn clear_photo_edit_undo() {
    if let Ok(mut state) = lock_state() {
        for entry in state.by_key.values() {
            remove_backup_file(&entry.backup_path);
        }
        state.by_key.clear();
    }
}

pub fn has_photo_edit_undo() -> bool {
    lock_state()
        .map(|s| !s.by_key.is_empty())
        .unwrap_or(false)
}

pub fn photo_edit_mark_paths() -> Vec<String> {
    lock_state()
        .map(|s| {
            s.by_key
                .values()
                .map(|e| e.restore_path.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Keep the first pre-edit backup for `input`.
pub fn prepare_overwrite_backup(input: &str) -> Result<Option<PathBuf>, PhotoEditUndoError> {
    if !Path::new(input).is_file() {
        return Err(PhotoEditUndoError::Message(format!(
            "input file not found: {input}"
        )));
    }
    crate::storage::file_link::materialize_hardlink(Path::new(input))?;
    let key = norm_key(input);
    let state = lock_state()?;
    if state.by_key.contains_key(&key) {
        return Ok(None);
    }
    drop(state);
    let backup = pre_edit_backup_path(input);
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    fs::copy(input, &backup)?;
    Ok(Some(backup))
}

pub fn discard_backup(backup: &Path) {
    remove_backup_file(backup);
}

pub fn commit_edit_undo(restore_path: &str, backup: Option<PathBuf>) {
    let Some(backup) = backup else {
        return;
    };
    let key = norm_key(restore_path);
    if let Ok(mut state) = lock_state() {
        state.by_key.insert(
            key,
            PhotoEditUndoEntry {
                restore_path: restore_path.to_string(),
                backup_path: backup,
            },
        );
    }
}

pub fn undo_edit_for_path(path: &str) -> Result<UndoPhotoEditResult, PhotoEditUndoError> {
    let key = norm_key(path);
    let mut state = lock_state()?;
    let entry = state.by_key.remove(&key).ok_or_else(|| {
        PhotoEditUndoError::Message("Keine rückgängig machbare Foto-Bearbeitung.".into())
    })?;
    drop(state);

    if !entry.backup_path.is_file() {
        return Err(PhotoEditUndoError::Message(
            "Undo-Backup fehlt (Datei wurde entfernt).".into(),
        ));
    }
    let restore = Path::new(&entry.restore_path);
    if let Some(parent) = restore.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = restore.with_file_name(format!(
        "{}.__undo_restore__",
        restore
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("photo")
    ));
    fs::copy(&entry.backup_path, &tmp)?;
    if restore.exists() {
        let _ = fs::remove_file(restore);
    }
    fs::rename(&tmp, restore)?;
    remove_backup_file(&entry.backup_path);
    Ok(UndoPhotoEditResult {
        restore_path: entry.restore_path,
    })
}

pub fn discard_edit_undo_for_path(path: &str) {
    let key = norm_key(path);
    if let Ok(mut state) = lock_state() {
        if let Some(entry) = state.by_key.remove(&key) {
            remove_backup_file(&entry.backup_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn backup_path_naming() {
        let p = pre_edit_backup_path("/work/DJI_0001.JPG");
        assert!(p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".__pre_edit__."));
    }

    #[test]
    fn prepare_commit_undo_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(b"orig").unwrap();
        }
        let path_str = path.to_string_lossy().to_string();
        clear_photo_edit_undo();
        let backup = prepare_overwrite_backup(&path_str).unwrap().unwrap();
        fs::write(&path, b"edited").unwrap();
        commit_edit_undo(&path_str, Some(backup));
        assert!(has_photo_edit_undo());
        let res = undo_edit_for_path(&path_str).unwrap();
        assert_eq!(res.restore_path, path_str);
        assert_eq!(fs::read(&path).unwrap(), b"orig");
        clear_photo_edit_undo();
    }
}
