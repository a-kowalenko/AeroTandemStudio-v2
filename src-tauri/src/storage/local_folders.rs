//! Phase 39: clear local job / backup folders on disk; history DBs stay intact.
//! Phase 42: age-filtered auto cleanup (same delete path; no orphans; skip retryable).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;

use crate::storage::cache::{
    normalize_key, path_size, remove_file, rmtree, CacheCleanupResult,
};
use crate::storage::config::AppConfig;
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

#[derive(Debug, Clone, Default, Serialize)]
pub struct AutoCleanupResult {
    pub ran: bool,
    /// Empty when ran; otherwise `disabled` | `already_today`.
    pub skip_reason: String,
    pub jobs: CacheCleanupResult,
    pub backups: CacheCleanupResult,
    /// Age-due Vorgänge skipped because upload is pending/uploading/retryable.
    pub jobs_skipped_retryable: u32,
    pub last_auto_cleanup_date: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct JobClearOptions {
    pub include_orphans: bool,
    /// When set, only folders whose Vorgang `created_at` is older than this many days.
    pub older_than_days: Option<u32>,
    /// With age filter: skip Vorgänge whose upload is still retryable (Phase 42 auto).
    pub skip_retryable_uploads: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BackupClearOptions {
    /// When set, only child folders older than this many days.
    pub older_than_days: Option<u32>,
}

#[derive(Debug, Clone)]
struct TargetSet {
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
    history_folder_count: u32,
    orphan_folder_count: u32,
    retryable_upload_count: u32,
    skipped_retryable: u32,
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

fn is_retryable_upload(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        "pending" | "failed" | "cancelled" | "canceled" | "uploading"
    )
}

/// Parse ISO timestamps written by `vorgang_history` (`…Z` or with offset).
pub fn parse_vorgang_created_at(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // `%Y-%m-%dT%H:%M:%SZ` without fractional seconds is already RFC3339;
    // also accept naive UTC with trailing Z via chrono flexible parse.
    if let Ok(naive) = NaiveDateTime::parse_from_str(s.trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S")
    {
        return Some(Utc.from_utc_datetime(&naive));
    }
    None
}

pub fn is_older_than_days(created_at: &str, retention_days: u32, now: DateTime<Utc>) -> bool {
    let Some(created) = parse_vorgang_created_at(created_at) else {
        // Unparseable → treat as not due (keep folder).
        return false;
    };
    let cutoff = now - Duration::days(retention_days as i64);
    created < cutoff
}

/// Extract `YYYYMMDD_HHMMSS` from `SD_Backup_{timestamp}[{pc}]_{hash}`.
pub fn parse_sd_backup_folder_timestamp(name: &str) -> Option<NaiveDateTime> {
    let rest = name.strip_prefix("SD_Backup_")?;
    if rest.len() < 15 {
        return None;
    }
    let ts = &rest[..15];
    if ts.as_bytes().get(8) != Some(&b'_') {
        return None;
    }
    if !ts.as_bytes().iter().enumerate().all(|(i, b)| {
        if i == 8 {
            *b == b'_'
        } else {
            b.is_ascii_digit()
        }
    }) {
        return None;
    }
    NaiveDateTime::parse_from_str(ts, "%Y%m%d_%H%M%S").ok()
}

fn folder_age_instant(path: &Path) -> Option<SystemTime> {
    let name = path.file_name()?.to_str()?;
    if let Some(naive) = parse_sd_backup_folder_timestamp(name) {
        let local = Local.from_local_datetime(&naive).single()?;
        return Some(SystemTime::from(local));
    }
    fs::metadata(path).ok()?.modified().ok()
}

fn backup_folder_is_older_than(path: &Path, retention_days: u32, now: SystemTime) -> bool {
    let Some(created) = folder_age_instant(path) else {
        return false;
    };
    let Ok(age) = now.duration_since(created) else {
        // Future timestamp → keep.
        return false;
    };
    age.as_secs() >= (retention_days as u64).saturating_mul(24 * 60 * 60)
}

fn collect_job_targets(
    root: &Path,
    store: &VorgangHistoryStore,
    opts: JobClearOptions,
) -> Result<TargetSet, String> {
    let refs = store
        .list_disk_folder_refs()
        .map_err(|e| e.to_string())?;

    let now = Utc::now();
    let age_filter = opts.older_than_days;

    // Per-Vorgang eligibility when age-filtering.
    let mut eligible_ids: Option<HashSet<i64>> = None;
    let mut skipped_retryable = 0u32;
    if let Some(days) = age_filter {
        let mut meta: HashMap<i64, (String, String)> = HashMap::new();
        for r in &refs {
            let entry = meta
                .entry(r.vorgang_id)
                .or_insert_with(|| (r.created_at.clone(), r.upload_state.clone()));
            if r.is_base {
                *entry = (r.created_at.clone(), r.upload_state.clone());
            }
        }
        let mut eligible = HashSet::new();
        for (id, (created_at, upload_state)) in &meta {
            if !is_older_than_days(created_at, days, now) {
                continue;
            }
            if opts.skip_retryable_uploads && is_retryable_upload(upload_state) {
                skipped_retryable = skipped_retryable.saturating_add(1);
                continue;
            }
            eligible.insert(*id);
        }
        eligible_ids = Some(eligible);
    }

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
        if let Some(eligible) = &eligible_ids {
            if !eligible.contains(&r.vorgang_id) {
                continue;
            }
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
    // Auto age-filter never includes orphans (Phase 42).
    let include_orphans = opts.include_orphans && age_filter.is_none();
    if include_orphans {
        let history_keys: HashSet<String> = dirs.iter().map(|p| normalize_key(p)).collect();
        let Ok(entries) = fs::read_dir(root) else {
            return Ok(TargetSet {
                dirs,
                files,
                history_folder_count,
                orphan_folder_count,
                retryable_upload_count,
                skipped_retryable,
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
        skipped_retryable,
    })
}

fn collect_backup_targets(root: &Path, opts: BackupClearOptions) -> TargetSet {
    let mut dirs = Vec::new();
    let mut orphan_folder_count = 0u32;
    let now = SystemTime::now();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !is_strict_child_of(root, &path) {
                continue;
            }
            if let Some(days) = opts.older_than_days {
                if !backup_folder_is_older_than(&path, days, now) {
                    continue;
                }
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
        skipped_retryable: 0,
    }
}

pub fn probe_clear_local_job_folders(
    speicherort: &str,
    store: &VorgangHistoryStore,
    include_orphans: bool,
) -> Result<LocalFolderClearProbe, String> {
    probe_clear_local_job_folders_opts(
        speicherort,
        store,
        JobClearOptions {
            include_orphans,
            ..Default::default()
        },
    )
}

pub fn probe_clear_local_job_folders_opts(
    speicherort: &str,
    store: &VorgangHistoryStore,
    opts: JobClearOptions,
) -> Result<LocalFolderClearProbe, String> {
    let trimmed = speicherort.trim();
    let Some(root) = resolve_existing_root(trimmed) else {
        return Ok(empty_probe(trimmed, false));
    };
    let targets = collect_job_targets(&root, store, opts)?;
    let mut probe = measure_targets(&targets);
    probe.root = root.to_string_lossy().into_owned();
    Ok(probe)
}

pub fn clear_local_job_folders(
    speicherort: &str,
    store: &VorgangHistoryStore,
    include_orphans: bool,
) -> Result<CacheCleanupResult, String> {
    clear_local_job_folders_opts(
        speicherort,
        store,
        JobClearOptions {
            include_orphans,
            ..Default::default()
        },
    )
    .map(|(result, _)| result)
}

pub fn clear_local_job_folders_opts(
    speicherort: &str,
    store: &VorgangHistoryStore,
    opts: JobClearOptions,
) -> Result<(CacheCleanupResult, u32), String> {
    let Some(root) = resolve_existing_root(speicherort) else {
        return Ok((CacheCleanupResult::default().finish(), 0));
    };
    let root_before = root.clone();
    let targets = collect_job_targets(&root, store, opts)?;
    let skipped = targets.skipped_retryable;
    let result = delete_targets(targets);
    debug_assert!(
        root_before.is_dir(),
        "speicherort root must never be deleted"
    );
    let _ = root_before;
    Ok((result, skipped))
}

pub fn probe_clear_local_backup_folders(sd_backup_folder: &str) -> LocalFolderClearProbe {
    probe_clear_local_backup_folders_opts(sd_backup_folder, BackupClearOptions::default())
}

pub fn probe_clear_local_backup_folders_opts(
    sd_backup_folder: &str,
    opts: BackupClearOptions,
) -> LocalFolderClearProbe {
    let trimmed = sd_backup_folder.trim();
    let Some(root) = resolve_existing_root(trimmed) else {
        return empty_probe(trimmed, false);
    };
    let targets = collect_backup_targets(&root, opts);
    let mut probe = measure_targets(&targets);
    probe.root = root.to_string_lossy().into_owned();
    probe
}

pub fn clear_local_backup_folders(sd_backup_folder: &str) -> CacheCleanupResult {
    clear_local_backup_folders_opts(sd_backup_folder, BackupClearOptions::default())
}

pub fn clear_local_backup_folders_opts(
    sd_backup_folder: &str,
    opts: BackupClearOptions,
) -> CacheCleanupResult {
    let Some(root) = resolve_existing_root(sd_backup_folder) else {
        return CacheCleanupResult::default().finish();
    };
    let root_before = root.clone();
    let targets = collect_backup_targets(&root, opts);
    let result = delete_targets(targets);
    debug_assert!(
        root_before.is_dir(),
        "sd_backup_folder root must never be deleted"
    );
    let _ = root_before;
    result
}

pub fn today_local_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Run age-filtered cleanup for enabled domains; persist `last_auto_cleanup_date`.
pub fn run_auto_cleanup(
    cfg: &mut AppConfig,
    store: &VorgangHistoryStore,
) -> Result<AutoCleanupResult, String> {
    cfg.sync_auto_cleanup_retention();
    let today = today_local_date();
    let jobs_on = cfg.auto_cleanup_jobs_enabled;
    let backups_on = cfg.auto_cleanup_backups_enabled;

    if !jobs_on && !backups_on {
        return Ok(AutoCleanupResult {
            ran: false,
            skip_reason: "disabled".into(),
            last_auto_cleanup_date: cfg.last_auto_cleanup_date.clone(),
            ..Default::default()
        });
    }

    if cfg.last_auto_cleanup_date.trim() == today {
        return Ok(AutoCleanupResult {
            ran: false,
            skip_reason: "already_today".into(),
            last_auto_cleanup_date: cfg.last_auto_cleanup_date.clone(),
            ..Default::default()
        });
    }

    let mut jobs = CacheCleanupResult::default().finish();
    let mut backups = CacheCleanupResult::default().finish();
    let mut jobs_skipped_retryable = 0u32;

    if jobs_on {
        let (result, skipped) = clear_local_job_folders_opts(
            &cfg.speicherort,
            store,
            JobClearOptions {
                include_orphans: false,
                older_than_days: Some(cfg.auto_cleanup_jobs_retention_days),
                skip_retryable_uploads: true,
            },
        )?;
        jobs = result;
        jobs_skipped_retryable = skipped;
    }

    if backups_on {
        backups = clear_local_backup_folders_opts(
            &cfg.sd_backup_folder,
            BackupClearOptions {
                older_than_days: Some(cfg.auto_cleanup_backups_retention_days),
            },
        );
    }

    cfg.last_auto_cleanup_date = today.clone();

    Ok(AutoCleanupResult {
        ran: true,
        skip_reason: String::new(),
        jobs,
        backups,
        jobs_skipped_retryable,
        last_auto_cleanup_date: today,
    })
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

    fn force_created_at(db_path: &Path, id: i64, iso: &str) {
        let conn = rusqlite::Connection::open(db_path).unwrap();
        conn.execute(
            "UPDATE vorgaenge SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![iso, id],
        )
        .unwrap();
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

    #[test]
    fn age_filter_keeps_fresh_deletes_old() {
        let root = tempdir().unwrap();
        let old_job = root.path().join("old_job");
        let fresh_job = root.path().join("fresh_job");
        fs::create_dir_all(&old_job).unwrap();
        fs::create_dir_all(&fresh_job).unwrap();
        fs::write(old_job.join("a.txt"), b"a").unwrap();
        fs::write(fresh_job.join("b.txt"), b"b").unwrap();

        let db = tempdir().unwrap();
        let db_path = db.path().join("v.db");
        let store = VorgangHistoryStore::open_at(db_path.clone()).unwrap();
        let old_id = store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&old_job),
                "oldschool",
                &[],
                None,
                false,
            )
            .unwrap();
        let fresh_id = store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&fresh_job),
                "oldschool",
                &[],
                None,
                false,
            )
            .unwrap();
        force_created_at(&db_path, old_id, "2020-01-01T12:00:00Z");
        force_created_at(
            &db_path,
            fresh_id,
            &Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        );

        let (result, skipped) = clear_local_job_folders_opts(
            root.path().to_str().unwrap(),
            &store,
            JobClearOptions {
                include_orphans: false,
                older_than_days: Some(14),
                skip_retryable_uploads: true,
            },
        )
        .unwrap();
        assert_eq!(skipped, 0);
        assert!(!old_job.exists());
        assert!(fresh_job.exists());
        assert!(root.path().is_dir());
        assert_eq!(result.deleted_dirs.len(), 1);
        assert_eq!(store.list_vorgaenge(10, None).unwrap().len(), 2);
    }

    #[test]
    fn age_filter_skips_retryable_upload() {
        let root = tempdir().unwrap();
        let job = root.path().join("pending_job");
        fs::create_dir_all(&job).unwrap();
        fs::write(job.join("clip.mp4"), b"data").unwrap();

        let db = tempdir().unwrap();
        let db_path = db.path().join("v.db");
        let store = VorgangHistoryStore::open_at(db_path.clone()).unwrap();
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
        force_created_at(&db_path, id, "2020-01-01T12:00:00Z");

        let (result, skipped) = clear_local_job_folders_opts(
            root.path().to_str().unwrap(),
            &store,
            JobClearOptions {
                include_orphans: false,
                older_than_days: Some(7),
                skip_retryable_uploads: true,
            },
        )
        .unwrap();
        assert_eq!(skipped, 1);
        assert!(job.exists());
        assert!(result.deleted_dirs.is_empty());
    }

    #[test]
    fn age_filter_deletes_append_with_parent() {
        let root = tempdir().unwrap();
        let base = root.path().join("old_base");
        let append = root.path().join("old_append");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&append).unwrap();

        let db = tempdir().unwrap();
        let db_path = db.path().join("v.db");
        let store = VorgangHistoryStore::open_at(db_path.clone()).unwrap();
        let id = store
            .insert_vorgang(
                &sample_kunde(),
                &sample_result(&base),
                "oldschool",
                &[],
                None,
                false,
            )
            .unwrap();
        store
            .record_append(
                id,
                "cid-a",
                "old_append",
                append.to_str().unwrap(),
                0,
                0,
                &[],
            )
            .unwrap();
        force_created_at(&db_path, id, "2020-06-01T00:00:00Z");

        let (_, skipped) = clear_local_job_folders_opts(
            root.path().to_str().unwrap(),
            &store,
            JobClearOptions {
                include_orphans: false,
                older_than_days: Some(30),
                skip_retryable_uploads: true,
            },
        )
        .unwrap();
        assert_eq!(skipped, 0);
        assert!(!base.exists());
        assert!(!append.exists());
        assert!(root.path().is_dir());
    }

    #[test]
    fn backup_timestamp_parse_and_age_filter() {
        assert_eq!(
            parse_sd_backup_folder_timestamp("SD_Backup_20240101_120000[Office-PC]_ab12")
                .unwrap()
                .format("%Y%m%d_%H%M%S")
                .to_string(),
            "20240101_120000"
        );
        assert_eq!(
            parse_sd_backup_folder_timestamp("SD_Backup_20240101_120000_ab12")
                .unwrap()
                .format("%Y%m%d_%H%M%S")
                .to_string(),
            "20240101_120000"
        );
        assert!(parse_sd_backup_folder_timestamp("not_a_backup").is_none());

        let root = tempdir().unwrap();
        let old = root.path().join("SD_Backup_20200101_120000_dead");
        let fresh_name = format!(
            "SD_Backup_{}_abcd",
            Local::now().format("%Y%m%d_%H%M%S")
        );
        let fresh = root.path().join(&fresh_name);
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&fresh).unwrap();

        let result = clear_local_backup_folders_opts(
            root.path().to_str().unwrap(),
            BackupClearOptions {
                older_than_days: Some(30),
            },
        );
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(root.path().is_dir());
        assert_eq!(result.deleted_dirs.len(), 1);
    }

    #[test]
    fn is_older_than_days_boundary() {
        let now = Utc::now();
        let old = (now - Duration::days(20)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let recent = (now - Duration::days(5)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
        assert!(is_older_than_days(&old, 14, now));
        assert!(!is_older_than_days(&recent, 14, now));
        assert!(!is_older_than_days("not-a-date", 14, now));
    }
}
