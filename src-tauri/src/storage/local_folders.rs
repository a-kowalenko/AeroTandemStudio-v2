//! Phase 39: clear local job / backup folders on disk; history DBs stay intact.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::storage::cache::{
    normalize_key, path_size, remove_file, rmtree, CacheCleanupResult,
};
use crate::storage::vorgang_history::VorgangHistoryStore;

#[derive(Debug, Clone, Default, Serialize)]
pub struct LocalFolderClearProbe {
    pub root: String,
    pub root_exists: bool,
    pub folder_count: u32,
    pub file_count: u32,
    pub history_folder_count: u32,
    pub orphan_folder_count: u32,
    pub bytes: u64,
    /// Vorgänge with retryable upload whose job folder would be deleted.
    pub retryable_upload_count: u32,
}

#[derive(Debug, Clone)]
struct TargetSet {
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
    history_folder_count: u32,
    orphan_folder_count: u32,
    retryable_upload_count: u32,
}

fn empty_probe(root: &str, exists: bool) -> LocalFolderClearProbe {
    LocalFolderClearProbe {
        root: root.to_string(),
        root_exists: exists,
        ..Default::default()
    }
}

/// True when `candidate` is strictly under `root` (root itself is never a match).
pub fn is_strict_child_of(root: &Path, candidate: &Path) -> bool {
    let root_key = normalize_key(root);
    let cand_key = normalize_key(candidate);
    if root_key.is_empty() || cand_key.is_empty() || root_key == cand_key {
        return false;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
    cand_key.starts_with(&root_key)
        && cand_key.as_bytes().get(root_key.len()) == Some(&(sep as u8))
}

fn resolve_existing_root(root: &str) -> Option<PathBuf> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return None;
    }
    Some(fs::canonicalize(&path).unwrap_or(path))
}

fn count_files_under(path: &Path) -> u32 {
    let mut n = 0u32;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                n = n.saturating_add(1);
            }
        }
    }
    n
}

fn measure_targets(targets: &TargetSet) -> LocalFolderClearProbe {
    let mut bytes = 0u64;
    // Nested files inside dirs + loose orphan files at root.
    let mut file_count = 0u32;
    for d in &targets.dirs {
        bytes = bytes.saturating_add(path_size(d));
        file_count = file_count.saturating_add(count_files_under(d));
    }
    for f in &targets.files {
        bytes = bytes.saturating_add(path_size(f));
        file_count = file_count.saturating_add(1);
    }
    LocalFolderClearProbe {
        root: String::new(),
        root_exists: true,
        folder_count: targets.dirs.len() as u32,
        file_count,
        history_folder_count: targets.history_folder_count,
        orphan_folder_count: targets.orphan_folder_count,
        bytes,
        retryable_upload_count: targets.retryable_upload_count,
    }
}

fn delete_targets(targets: TargetSet) -> CacheCleanupResult {
    let mut result = CacheCleanupResult::default();
    for dir in &targets.dirs {
        rmtree(dir, &mut result);
    }
    for file in &targets.files {
        remove_file(file, &mut result);
    }
    result.finish()
}

fn collect_job_targets(
    root: &Path,
    store: &VorgangHistoryStore,
    include_orphans: bool,
) -> Result<TargetSet, String> {
    let refs = store
        .list_disk_folder_refs()
        .map_err(|e| e.to_string())?;

    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    let mut history_folder_count = 0u32;
    let mut retryable_upload_count = 0u32;
    let mut retryable_seen = HashSet::new();

    for r in &refs {
        let raw = r.path.trim();
        if raw.is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        if !path.exists() {
            continue;
        }
        if !is_strict_child_of(root, &path) {
            continue;
        }
        let key = normalize_key(&path);
        if !seen.insert(key) {
            continue;
        }
        if path.is_dir() {
            history_folder_count = history_folder_count.saturating_add(1);
            dirs.push(path);
            if r.is_base
                && is_retryable_upload(&r.upload_state)
                && retryable_seen.insert(r.vorgang_id)
            {
                retryable_upload_count = retryable_upload_count.saturating_add(1);
            }
        } else if path.is_file() {
            // Append/history paths should be dirs; ignore stray files.
        }
    }

    let mut files = Vec::new();
    let mut orphan_folder_count = 0u32;
    if include_orphans {
        let history_keys: HashSet<String> = dirs.iter().map(|p| normalize_key(p)).collect();
        let Ok(entries) = fs::read_dir(root) else {
            return Ok(TargetSet {
                dirs,
                files,
                history_folder_count,
                orphan_folder_count,
                retryable_upload_count,
            });
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_strict_child_of(root, &path) {
                continue;
            }
            let key = normalize_key(&path);
            if history_keys.contains(&key) || seen.contains(&key) {
                continue;
            }
            if path.is_dir() {
                orphan_folder_count = orphan_folder_count.saturating_add(1);
                seen.insert(key);
                dirs.push(path);
            } else if path.is_file() {
                seen.insert(key);
                files.push(path);
            }
        }
    }

    dirs.sort();
    files.sort();
    Ok(TargetSet {
        dirs,
        files,
        history_folder_count,
        orphan_folder_count,
        retryable_upload_count,
    })
}

fn is_retryable_upload(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        "pending" | "failed" | "cancelled" | "canceled" | "uploading"
    )
}

fn collect_backup_targets(root: &Path) -> TargetSet {
    let mut dirs = Vec::new();
    let mut orphan_folder_count = 0u32;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !is_strict_child_of(root, &path) {
                continue;
            }
            orphan_folder_count = orphan_folder_count.saturating_add(1);
            dirs.push(path);
        }
    }
    dirs.sort();
    TargetSet {
        dirs,
        files: Vec::new(),
        history_folder_count: 0,
        orphan_folder_count,
        retryable_upload_count: 0,
    }
}

pub fn probe_clear_local_job_folders(
    speicherort: &str,
    store: &VorgangHistoryStore,
    include_orphans: bool,
) -> Result<LocalFolderClearProbe, String> {
    let trimmed = speicherort.trim();
    let Some(root) = resolve_existing_root(trimmed) else {
        return Ok(empty_probe(trimmed, false));
    };
    let targets = collect_job_targets(&root, store, include_orphans)?;
    let mut probe = measure_targets(&targets);
    probe.root = root.to_string_lossy().into_owned();
    Ok(probe)
}

pub fn clear_local_job_folders(
    speicherort: &str,
    store: &VorgangHistoryStore,
    include_orphans: bool,
) -> Result<CacheCleanupResult, String> {
    let Some(root) = resolve_existing_root(speicherort) else {
        return Ok(CacheCleanupResult::default().finish());
    };
    let root_before = root.clone();
    let targets = collect_job_targets(&root, store, include_orphans)?;
    let result = delete_targets(targets);
    debug_assert!(
        root_before.is_dir(),
        "speicherort root must never be deleted"
    );
    let _ = root_before;
    Ok(result)
}

pub fn probe_clear_local_backup_folders(sd_backup_folder: &str) -> LocalFolderClearProbe {
    let trimmed = sd_backup_folder.trim();
    let Some(root) = resolve_existing_root(trimmed) else {
        return empty_probe(trimmed, false);
    };
    let targets = collect_backup_targets(&root);
    let mut probe = measure_targets(&targets);
    probe.root = root.to_string_lossy().into_owned();
    probe
}

pub fn clear_local_backup_folders(sd_backup_folder: &str) -> CacheCleanupResult {
    let Some(root) = resolve_existing_root(sd_backup_folder) else {
        return CacheCleanupResult::default().finish();
    };
    let root_before = root.clone();
    let targets = collect_backup_targets(&root);
    let result = delete_targets(targets);
    debug_assert!(
        root_before.is_dir(),
        "sd_backup_folder root must never be deleted"
    );
    let _ = root_before;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::kunde::Kunde;
    use crate::storage::vorgang_history::VorgangHistoryStore;
    use crate::video::export_job::CreateJobResult;
    use tempfile::tempdir;

    fn sample_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.gast = "Test Gast".into();
        k.datum = "28.08.2026".into();
        k.ort = "Calden".into();
        k.tandemmaster = "TM".into();
        k.handcam_video = true;
        k.ist_bezahlt_handcam_video = true;
        k.form_mode = "manual".into();
        k
    }

    fn sample_result(dir: &Path) -> CreateJobResult {
        CreateJobResult {
            base_output_dir: dir.to_string_lossy().into_owned(),
            base_filename: "Test_Gast".into(),
            video_output: None,
            watermark_video: None,
            photos_copied: 0,
            watermark_photos: 0,
            marker_path: dir.join("_fertig.txt").to_string_lossy().into_owned(),
            encoder: "libx264".into(),
            intro_created: false,
            body_clips: 0,
            reused_preview: false,
            correlation_id: "cid-phase39".into(),
            vorgang_id: None,
        }
    }

    #[test]
    fn path_escape_rejected() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        assert!(!is_strict_child_of(root.path(), outside.path()));
        assert!(!is_strict_child_of(root.path(), root.path()));
        let child = root.path().join("job_a");
        fs::create_dir_all(&child).unwrap();
        assert!(is_strict_child_of(root.path(), &child));
    }

    #[test]
    fn clear_jobs_keeps_root_and_history() {
        let root = tempdir().unwrap();
        let job = root.path().join("20260828_Gast_TA_TM");
        fs::create_dir_all(&job).unwrap();
        fs::write(job.join("clip.mp4"), b"data").unwrap();

        let db = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(db.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&job),
                "oldschool",
                &[],
                None,
                true,
            )
            .unwrap();
        store
            .update_upload_state(Some(id), "", "pending")
            .unwrap();

        let probe = probe_clear_local_job_folders(
            root.path().to_str().unwrap(),
            &store,
            false,
        )
        .unwrap();
        assert!(probe.root_exists);
        assert_eq!(probe.history_folder_count, 1);
        assert_eq!(probe.folder_count, 1);
        assert_eq!(probe.retryable_upload_count, 1);
        assert!(probe.bytes >= 4);
        assert_eq!(probe.file_count, 1);

        let result =
            clear_local_job_folders(root.path().to_str().unwrap(), &store, false).unwrap();
        assert!(!job.exists());
        assert!(root.path().is_dir());
        assert_eq!(result.deleted_dirs.len(), 1);

        let list = store.list_vorgaenge(10, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].upload_state, "pending");
    }

    #[test]
    fn orphan_toggle_includes_unknown_children() {
        let root = tempdir().unwrap();
        let known = root.path().join("known_job");
        let orphan = root.path().join("orphan_job");
        fs::create_dir_all(&known).unwrap();
        fs::create_dir_all(&orphan).unwrap();
        fs::write(known.join("a.txt"), b"a").unwrap();
        fs::write(orphan.join("b.txt"), b"b").unwrap();

        let db = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(db.path().join("v.db")).unwrap();
        store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&known),
                "oldschool",
                &[],
                None,
                true,
            )
            .unwrap();

        let without = probe_clear_local_job_folders(
            root.path().to_str().unwrap(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(without.folder_count, 1);
        assert_eq!(without.orphan_folder_count, 0);

        let with = probe_clear_local_job_folders(
            root.path().to_str().unwrap(),
            &store,
            true,
        )
        .unwrap();
        assert_eq!(with.folder_count, 2);
        assert_eq!(with.orphan_folder_count, 1);

        clear_local_job_folders(root.path().to_str().unwrap(), &store, true).unwrap();
        assert!(!known.exists());
        assert!(!orphan.exists());
        assert!(root.path().is_dir());
    }

    #[test]
    fn clear_backups_only_children() {
        let root = tempdir().unwrap();
        let child_a = root.path().join("cam_a");
        let child_b = root.path().join("cam_b");
        fs::create_dir_all(&child_a).unwrap();
        fs::create_dir_all(&child_b).unwrap();
        fs::write(child_a.join("x.bin"), b"12345").unwrap();

        let probe = probe_clear_local_backup_folders(root.path().to_str().unwrap());
        assert_eq!(probe.folder_count, 2);
        assert_eq!(probe.file_count, 1);
        assert!(probe.bytes >= 5);

        let result = clear_local_backup_folders(root.path().to_str().unwrap());
        assert!(!child_a.exists());
        assert!(!child_b.exists());
        assert!(root.path().is_dir());
        assert_eq!(result.deleted_dirs.len(), 2);
    }

    #[test]
    fn append_folder_under_root_is_cleared() {
        let root = tempdir().unwrap();
        let base = root.path().join("base_job");
        let append = root.path().join("append_job");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&append).unwrap();
        fs::write(append.join("extra.mp4"), b"xx").unwrap();

        let db = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(db.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&base),
                "oldschool",
                &[],
                None,
                true,
            )
            .unwrap();
        store
            .record_append(
                id,
                "cid-append",
                "append_job",
                append.to_str().unwrap(),
                1,
                0,
                &["handcam_video".into()],
            )
            .unwrap();

        let probe = probe_clear_local_job_folders(
            root.path().to_str().unwrap(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(probe.history_folder_count, 2);

        clear_local_job_folders(root.path().to_str().unwrap(), &store, false).unwrap();
        assert!(!base.exists());
        assert!(!append.exists());
        assert_eq!(store.list_vorgaenge(10, None).unwrap().len(), 1);
        assert_eq!(store.list_appends(id).unwrap().len(), 1);
    }
}
