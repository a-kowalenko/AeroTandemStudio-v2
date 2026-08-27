//! Deferred cleanup of abandoned SMB upload staging folders.
//!
//! Uploads write under `.ats_staging/<id>/…` and promote into the final job
//! name only on success. Cancel/fail enqueues the staging root here so a
//! later idle connection can delete it after exclusive writer locks clear.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::storage::app_config_dir;
use crate::storage::logging;

const GC_FILE_NAME: &str = "smb_staging_gc.json";
const STAGING_DIR_NAME: &str = ".ats_staging";
const MAX_ATTEMPTS: u32 = 12;
const MAX_DRAIN_PER_PASS: usize = 8;

/// In-process lock so enqueue/drain do not clobber the JSON file.
static GC_FILE_LOCK: Mutex<()> = Mutex::new(());

/// Target for a deferred remote staging delete (no credentials stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagingGcEntry {
    pub host: String,
    pub port: u16,
    pub share: String,
    /// Relative path under the share, e.g. `uploads/.ats_staging/<uuid>`.
    pub staging_root: String,
    pub attempts: u32,
    /// Unix seconds; drain skips entries until this time.
    pub next_attempt_unix: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct GcFile {
    entries: Vec<StagingGcEntry>,
}

pub fn staging_dir_name() -> &'static str {
    STAGING_DIR_NAME
}

fn gc_path() -> Result<PathBuf, String> {
    Ok(app_config_dir().map_err(|e| e.to_string())?.join(GC_FILE_NAME))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn backoff_secs(attempts: u32) -> i64 {
    // 2, 4, 8, … capped at 5 minutes
    let exp = attempts.max(1).min(9);
    let secs = 2i64.saturating_pow(exp);
    secs.min(300)
}

fn load_unlocked() -> GcFile {
    let Ok(path) = gc_path() else {
        return GcFile::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return GcFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_unlocked(file: &GcFile) -> Result<(), String> {
    let path = gc_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Remember a staging tree for later deletion (idempotent on same path).
pub fn enqueue_staging_gc(entry: StagingGcEntry) {
    let _guard = GC_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_unlocked();
    if let Some(existing) = file
        .entries
        .iter_mut()
        .find(|e| e.host == entry.host && e.port == entry.port && e.share == entry.share && e.staging_root == entry.staging_root)
    {
        // Keep the sooner next attempt; do not reset attempts downward.
        existing.next_attempt_unix = existing.next_attempt_unix.min(entry.next_attempt_unix);
    } else {
        file.entries.push(entry);
    }
    if let Err(e) = save_unlocked(&file) {
        logging::warn("smb", format!("Staging-GC enqueue fehlgeschlagen: {e}"));
    }
}

pub fn enqueue_new_staging_gc(host: &str, port: u16, share: &str, staging_root: &str) {
    if staging_root.trim().is_empty() {
        return;
    }
    enqueue_staging_gc(StagingGcEntry {
        host: host.to_string(),
        port,
        share: share.to_string(),
        staging_root: staging_root.trim_matches('/').replace('\\', "/"),
        attempts: 0,
        next_attempt_unix: now_unix(),
    });
}

/// Remove a staging root from the queue after a successful delete.
pub fn dequeue_staging_gc(host: &str, port: u16, share: &str, staging_root: &str) {
    let _guard = GC_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_unlocked();
    let before = file.entries.len();
    file.entries.retain(|e| {
        !(e.host == host
            && e.port == port
            && e.share == share
            && e.staging_root == staging_root)
    });
    if file.entries.len() != before {
        let _ = save_unlocked(&file);
    }
}

fn mark_attempt_result(host: &str, port: u16, share: &str, staging_root: &str, ok: bool) {
    let _guard = GC_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_unlocked();
    if ok {
        file.entries.retain(|e| {
            !(e.host == host
                && e.port == port
                && e.share == share
                && e.staging_root == staging_root)
        });
    } else if let Some(e) = file.entries.iter_mut().find(|e| {
        e.host == host && e.port == port && e.share == share && e.staging_root == staging_root
    }) {
        e.attempts = e.attempts.saturating_add(1);
        if e.attempts >= MAX_ATTEMPTS {
            logging::warn(
                "smb",
                format!(
                    "Staging-GC aufgegeben nach {} Versuchen: //{}/{}/{}",
                    e.attempts, e.host, e.share, e.staging_root
                ),
            );
            file.entries.retain(|x| {
                !(x.host == host
                    && x.port == port
                    && x.share == share
                    && x.staging_root == staging_root)
            });
        } else {
            e.next_attempt_unix = now_unix() + backoff_secs(e.attempts);
        }
    }
    let _ = save_unlocked(&file);
}

/// Build `subpath/.ats_staging/<id>` (share-relative).
pub fn staging_prefix(subpath: &str, staging_id: &str) -> String {
    let leaf = format!("{STAGING_DIR_NAME}/{staging_id}");
    let sub = subpath.trim_matches('/').trim_matches('\\').replace('\\', "/");
    if sub.is_empty() {
        leaf
    } else {
        format!("{sub}/{leaf}")
    }
}

/// Entries due for an attempt (for tests / diagnostics).
pub fn list_due_staging_gc() -> Vec<StagingGcEntry> {
    let _guard = GC_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = now_unix();
    load_unlocked()
        .entries
        .into_iter()
        .filter(|e| e.next_attempt_unix <= now)
        .take(MAX_DRAIN_PER_PASS)
        .collect()
}

/// How long callers may sleep before expecting the next GC retry.
pub fn min_gc_backoff() -> Duration {
    Duration::from_secs(2)
}

pub(crate) fn record_gc_attempt(
    host: &str,
    port: u16,
    share: &str,
    staging_root: &str,
    ok: bool,
) {
    mark_attempt_result(host, port, share, staging_root, ok);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_gc<R>(f: impl FnOnce() -> R) -> R {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        // Point app_config_dir indirectly by writing via save after monkeypatch is hard;
        // instead exercise enqueue/dequeue logic with isolated file by overriding path
        // through env is not available — unit-test pure helpers + in-memory-style via
        // staging_prefix and backoff only when file IO is awkward.
        let _ = dir;
        f()
    }

    #[test]
    fn staging_prefix_joins_subpath() {
        assert_eq!(
            staging_prefix("uploads/in", "abc"),
            "uploads/in/.ats_staging/abc"
        );
        assert_eq!(staging_prefix("", "abc"), ".ats_staging/abc");
        assert_eq!(staging_prefix("/", "abc"), ".ats_staging/abc");
    }

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(2), 4);
        assert_eq!(backoff_secs(8), 256);
        assert_eq!(backoff_secs(9), 300);
        assert_eq!(backoff_secs(20), 300);
    }

    #[test]
    fn enqueue_dequeue_roundtrip() {
        with_temp_gc(|| {
            // Use real app_config_dir — isolate by unique staging path.
            let id = format!("test-{}", uuid::Uuid::new_v4());
            let root = format!(".ats_staging/{id}");
            enqueue_new_staging_gc("127.0.0.1", 445, "share", &root);
            let due = list_due_staging_gc();
            assert!(
                due.iter().any(|e| e.staging_root == root),
                "expected {root} in {due:?}"
            );
            dequeue_staging_gc("127.0.0.1", 445, "share", &root);
            let due2 = list_due_staging_gc();
            assert!(!due2.iter().any(|e| e.staging_root == root));
        });
    }
}
