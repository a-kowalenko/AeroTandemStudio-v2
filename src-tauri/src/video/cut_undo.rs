//! Multi-clip undo for overwrite trim/split on working copies.
//!
//! Each cut path keeps the **first** pre-cut backup so undo restores the
//! working copy from before any cuts on that lineage. Session clear discards
//! all backups.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use thiserror::Error;

static CUT_UNDO: Lazy<Mutex<CutUndoState>> = Lazy::new(|| Mutex::new(CutUndoState::default()));

#[derive(Debug, Error)]
pub enum CutUndoError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
enum CutUndoKind {
    Trim,
    Split { part1: String, part2: String },
}

#[derive(Debug, Clone)]
struct CutUndoEntry {
    kind: CutUndoKind,
    /// Path restored on undo (original working-copy path).
    restore_path: String,
    backup_path: PathBuf,
}

#[derive(Debug, Default)]
struct CutUndoState {
    /// Keyed by normalized restore_path (trim) or original path (split).
    by_key: HashMap<String, CutUndoEntry>,
    /// part path (lower) → split entry key
    split_parts: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UndoCutResult {
    pub kind: String,
    pub restore_path: String,
    /// Paths removed from disk (split parts); UI should drop them from the list.
    pub removed_paths: Vec<String>,
    /// Paths that should lose their "cut" chip after this undo.
    pub cleared_mark_paths: Vec<String>,
}

fn norm_key(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

/// Sibling backup path: `name.__pre_cut__.ext`.
pub fn pre_cut_backup_path(video_path: &str) -> PathBuf {
    let path = Path::new(video_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    path.with_file_name(format!("{stem}.__pre_cut__.{ext}"))
}

fn lock_state() -> Result<std::sync::MutexGuard<'static, CutUndoState>, CutUndoError> {
    CUT_UNDO
        .lock()
        .map_err(|_| CutUndoError::Message("cut undo lock poisoned".into()))
}

fn remove_backup_file(path: &Path) {
    let _ = fs::remove_file(path);
}

impl CutUndoState {
    fn clear_all(&mut self) {
        for entry in self.by_key.values() {
            remove_backup_file(&entry.backup_path);
        }
        self.by_key.clear();
        self.split_parts.clear();
    }

    fn remove_entry(&mut self, key: &str) -> Option<CutUndoEntry> {
        let entry = self.by_key.remove(key)?;
        if let CutUndoKind::Split { part1, part2 } = &entry.kind {
            self.split_parts.remove(&norm_key(part1));
            self.split_parts.remove(&norm_key(part2));
        }
        Some(entry)
    }
}

/// Drop all undo slots and delete backup files.
pub fn clear_cut_undo() {
    if let Ok(mut state) = lock_state() {
        state.clear_all();
    }
}

pub fn has_cut_undo() -> bool {
    lock_state()
        .map(|s| !s.by_key.is_empty())
        .unwrap_or(false)
}

/// Paths that currently have an undoable cut (trim path, or both split parts).
pub fn cut_mark_paths() -> Vec<String> {
    let Ok(state) = lock_state() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in state.by_key.values() {
        match &entry.kind {
            CutUndoKind::Trim => out.push(entry.restore_path.clone()),
            CutUndoKind::Split { part1, part2 } => {
                out.push(part1.clone());
                out.push(part2.clone());
            }
        }
    }
    out
}

/// Ensure a first-generation backup exists for `input`.
///
/// Returns `Some(backup)` when a new backup was created (caller should commit),
/// or `None` when an older backup for this path is already kept.
pub fn prepare_overwrite_backup(input: &str) -> Result<Option<PathBuf>, CutUndoError> {
    if !Path::new(input).is_file() {
        return Err(CutUndoError::Message(format!(
            "input file not found: {input}"
        )));
    }
    crate::storage::file_link::materialize_hardlink(Path::new(input))?;
    let key = norm_key(input);
    let state = lock_state()?;
    if state.by_key.contains_key(&key) {
        return Ok(None);
    }
    // Cutting a split-part that already has a parent split entry: new key for this part.
    let backup = pre_cut_backup_path(input);
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    fs::copy(input, &backup)?;
    Ok(Some(backup))
}

/// Forget a backup created by [`prepare_overwrite_backup`] when the cut failed
/// before overwrite completed.
pub fn discard_backup(backup: &Path) {
    remove_backup_file(backup);
}

pub fn commit_trim_undo(restore_path: &str, backup: Option<PathBuf>) {
    let Some(backup) = backup else {
        return;
    };
    let key = norm_key(restore_path);
    if let Ok(mut state) = lock_state() {
        // Drop any stale split-part index pointing at this path.
        state.split_parts.remove(&key);
        state.by_key.insert(
            key,
            CutUndoEntry {
                kind: CutUndoKind::Trim,
                restore_path: restore_path.to_string(),
                backup_path: backup,
            },
        );
    }
}

pub fn commit_split_undo(
    restore_path: &str,
    part1: &str,
    part2: &str,
    backup: Option<PathBuf>,
) {
    let Some(backup) = backup else {
        // Already had an entry for this original — upgrade kind to split.
        let key = norm_key(restore_path);
        if let Ok(mut state) = lock_state() {
            if let Some(entry) = state.by_key.get_mut(&key) {
                entry.kind = CutUndoKind::Split {
                    part1: part1.to_string(),
                    part2: part2.to_string(),
                };
                state
                    .split_parts
                    .insert(norm_key(part1), key.clone());
                state.split_parts.insert(norm_key(part2), key);
            }
        }
        return;
    };
    let key = norm_key(restore_path);
    if let Ok(mut state) = lock_state() {
        // Remove prior trim entry for original if present.
        let _ = state.remove_entry(&key);
        state.by_key.insert(
            key.clone(),
            CutUndoEntry {
                kind: CutUndoKind::Split {
                    part1: part1.to_string(),
                    part2: part2.to_string(),
                },
                restore_path: restore_path.to_string(),
                backup_path: backup,
            },
        );
        state.split_parts.insert(norm_key(part1), key.clone());
        state.split_parts.insert(norm_key(part2), key);
    }
}

fn restore_entry(entry: CutUndoEntry) -> Result<UndoCutResult, CutUndoError> {
    if !entry.backup_path.is_file() {
        return Err(CutUndoError::Message(
            "Undo-Backup fehlt (Datei wurde entfernt).".into(),
        ));
    }

    let (removed_paths, cleared_mark_paths, kind) = match &entry.kind {
        CutUndoKind::Trim => {
            let restore = Path::new(&entry.restore_path);
            if let Some(parent) = restore.parent() {
                fs::create_dir_all(parent)?;
            }
            let tmp = restore.with_file_name(format!(
                "{}.__undo_restore__",
                restore
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("video")
            ));
            fs::copy(&entry.backup_path, &tmp)?;
            if restore.exists() {
                let _ = fs::remove_file(restore);
            }
            fs::rename(&tmp, restore)?;
            (
                Vec::new(),
                vec![entry.restore_path.clone()],
                "trim",
            )
        }
        CutUndoKind::Split { part1, part2 } => {
            for p in [part1.as_str(), part2.as_str()] {
                let path = Path::new(p);
                if path.exists() {
                    let _ = fs::remove_file(path);
                }
            }
            let restore = Path::new(&entry.restore_path);
            if let Some(parent) = restore.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&entry.backup_path, restore)?;
            (
                vec![part1.clone(), part2.clone()],
                vec![part1.clone(), part2.clone()],
                "split",
            )
        }
    };

    remove_backup_file(&entry.backup_path);

    Ok(UndoCutResult {
        kind: kind.into(),
        restore_path: entry.restore_path,
        removed_paths,
        cleared_mark_paths,
    })
}

fn resolve_entry_key(state: &CutUndoState, path: &str) -> Option<String> {
    let n = norm_key(path);
    if state.by_key.contains_key(&n) {
        return Some(n);
    }
    state.split_parts.get(&n).cloned()
}

/// Drop undo for `path` without restoring (e.g. clip removed from list).
pub fn discard_cut_undo_for_path(path: &str) {
    let Ok(mut state) = lock_state() else {
        return;
    };
    let Some(key) = resolve_entry_key(&state, path) else {
        return;
    };
    if let Some(entry) = state.remove_entry(&key) {
        remove_backup_file(&entry.backup_path);
    }
}

/// Undo the cut that owns `path` (trim path or either split part).
pub fn undo_cut_for_path(path: &str) -> Result<UndoCutResult, CutUndoError> {
    let entry = {
        let mut state = lock_state()?;
        let key = resolve_entry_key(&state, path).ok_or_else(|| {
            CutUndoError::Message("Kein rückgängig machbarer Schnitt für diesen Clip.".into())
        })?;
        state
            .remove_entry(&key)
            .ok_or_else(|| CutUndoError::Message("Undo-Eintrag fehlt.".into()))?
    };
    restore_entry(entry)
}

/// Undo every recorded cut (newest-independent; each entry restored once).
pub fn undo_all_cuts() -> Result<Vec<UndoCutResult>, CutUndoError> {
    let entries: Vec<CutUndoEntry> = {
        let mut state = lock_state()?;
        let keys: Vec<String> = state.by_key.keys().cloned().collect();
        keys.into_iter()
            .filter_map(|k| state.remove_entry(&k))
            .collect()
    };
    if entries.is_empty() {
        return Err(CutUndoError::Message(
            "Kein rückgängig machbarer Schnitt vorhanden.".into(),
        ));
    }
    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        results.push(restore_entry(entry)?);
    }
    Ok(results)
}

/// Restore the last overwrite cut/split (legacy single-slot helper → undoes one arbitrary entry).
pub fn undo_last_cut() -> Result<UndoCutResult, CutUndoError> {
    let entry = {
        let mut state = lock_state()?;
        let key = state.by_key.keys().next().cloned().ok_or_else(|| {
            CutUndoError::Message("Kein rückgängig machbarer Schnitt vorhanden.".into())
        })?;
        state
            .remove_entry(&key)
            .ok_or_else(|| CutUndoError::Message("Undo-Eintrag fehlt.".into()))?
    };
    restore_entry(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn with_isolated<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_cut_undo();
        let out = f();
        clear_cut_undo();
        out
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut f = fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn pre_cut_backup_naming() {
        let p = pre_cut_backup_path("/work/DJI_0001.mp4");
        assert_eq!(
            p.file_name().unwrap().to_string_lossy(),
            "DJI_0001.__pre_cut__.mp4"
        );
    }

    #[test]
    fn trim_keeps_first_backup_across_second_cut() {
        with_isolated(|| {
            let dir = tempfile::tempdir().unwrap();
            let clip = dir.path().join("clip.mp4");
            write_file(&clip, b"ORIGINAL");
            let bak1 = prepare_overwrite_backup(clip.to_str().unwrap()).unwrap();
            assert!(bak1.is_some());
            commit_trim_undo(clip.to_str().unwrap(), bak1);
            write_file(&clip, b"TRIM1");

            let bak2 = prepare_overwrite_backup(clip.to_str().unwrap()).unwrap();
            assert!(bak2.is_none());
            commit_trim_undo(clip.to_str().unwrap(), bak2);
            write_file(&clip, b"TRIM2");

            let res = undo_cut_for_path(clip.to_str().unwrap()).unwrap();
            assert_eq!(res.kind, "trim");
            assert_eq!(fs::read(&clip).unwrap(), b"ORIGINAL");
        });
    }

    #[test]
    fn split_undo_via_part_path() {
        with_isolated(|| {
            let dir = tempfile::tempdir().unwrap();
            let clip = dir.path().join("clip.mp4");
            let part1 = dir.path().join("clip_1.mp4");
            let part2 = dir.path().join("clip_2.mp4");
            write_file(&clip, b"ORIGINAL");
            let bak = prepare_overwrite_backup(clip.to_str().unwrap()).unwrap();
            write_file(&part1, b"P1");
            write_file(&part2, b"P2");
            let _ = fs::remove_file(&clip);
            commit_split_undo(
                clip.to_str().unwrap(),
                part1.to_str().unwrap(),
                part2.to_str().unwrap(),
                bak,
            );

            let res = undo_cut_for_path(part2.to_str().unwrap()).unwrap();
            assert_eq!(res.kind, "split");
            assert!(clip.is_file());
            assert_eq!(fs::read(&clip).unwrap(), b"ORIGINAL");
            assert!(!part1.exists());
            assert!(!part2.exists());
        });
    }

    #[test]
    fn undo_all_restores_multiple() {
        with_isolated(|| {
            let dir = tempfile::tempdir().unwrap();
            let a = dir.path().join("a.mp4");
            let b = dir.path().join("b.mp4");
            write_file(&a, b"A0");
            write_file(&b, b"B0");
            let ba = prepare_overwrite_backup(a.to_str().unwrap()).unwrap();
            commit_trim_undo(a.to_str().unwrap(), ba);
            write_file(&a, b"A1");
            let bb = prepare_overwrite_backup(b.to_str().unwrap()).unwrap();
            commit_trim_undo(b.to_str().unwrap(), bb);
            write_file(&b, b"B1");

            let results = undo_all_cuts().unwrap();
            assert_eq!(results.len(), 2);
            assert_eq!(fs::read(&a).unwrap(), b"A0");
            assert_eq!(fs::read(&b).unwrap(), b"B0");
            assert!(!has_cut_undo());
        });
    }
}
