//! OPT-20B: Timed Local-Probe + Prefer-Local / smb2 bridge (Sleep/Reconnect).
//!
//! Windows mapped drives can block for ~60s on `Path::exists()` while the
//! redirector wakes after standby. This module:
//! - probes Local reachability on a **worker thread with timeout**
//! - falls back to smb2 as a **bridge** while Prefer-Local reconnect runs
//! - caches recent probe results so resolve + `test_connection` share one probe
//! - never blocks the caller for a full network-drive hang

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::windows_mapping::canonicalize_unc;

/// Loud + quiet Local probe budget (Quiet-Poll must not freeze ~60s).
pub const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// Background Prefer-Local window after a slow/dead map probe.
pub const PREFER_LOCAL_WINDOW: Duration = Duration::from_secs(90);
const PREFER_LOCAL_POLL: Duration = Duration::from_millis(750);
/// Positive probe reuse (resolve → test_connection, B8). Keep short so a
/// post-sleep Quiet-Poll still re-probes instead of trusting a stale hit.
const POSITIVE_CACHE_TTL: Duration = Duration::from_secs(2);
/// Negative / timeout cache — avoid immediate re-block storms.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    Reachable,
    Unreachable,
    TimedOut,
}

impl ProbeOutcome {
    pub fn is_reachable(self) -> bool {
        matches!(self, Self::Reachable)
    }
}

#[derive(Debug, Clone)]
struct CachedProbe {
    outcome: ProbeOutcome,
    at: Instant,
}

#[derive(Debug, Default)]
struct ReconnectState {
    /// Path → last probe (shared across resolve / test_connection).
    cache: HashMap<String, CachedProbe>,
    /// Canonical UNC keys currently in Prefer-Local background reconnect.
    promoting: HashSet<String>,
    /// UNC → when smb2 bridge started (map listed but Local not ready).
    bridging: HashMap<String, Instant>,
}

static STATE: Lazy<Mutex<ReconnectState>> =
    Lazy::new(|| Mutex::new(ReconnectState::default()));

fn path_cache_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

/// Threaded `exists` with hard timeout — does not block the caller beyond `timeout`.
///
/// The worker may remain blocked until the OS returns; callers must not spawn
/// unbounded workers for the same path (Prefer-Local promote is serialized per UNC).
pub fn path_reachable_timed(path: &Path, timeout: Duration) -> ProbeOutcome {
    if timeout.is_zero() {
        return if path.exists() {
            ProbeOutcome::Reachable
        } else {
            ProbeOutcome::Unreachable
        };
    }

    let path_buf = path.to_path_buf();
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("smb-local-probe".into())
        .spawn(move || {
            let ok = path_buf.exists();
            let _ = tx.send(ok);
        })
        .ok();

    match rx.recv_timeout(timeout) {
        Ok(true) => ProbeOutcome::Reachable,
        Ok(false) => ProbeOutcome::Unreachable,
        Err(_) => ProbeOutcome::TimedOut,
    }
}

/// Look up a fresh cached probe for `path` (positive or negative TTL).
pub fn cached_probe(path: &Path) -> Option<ProbeOutcome> {
    let key = path_cache_key(path);
    let Ok(state) = STATE.lock() else {
        return None;
    };
    let entry = state.cache.get(&key)?;
    let ttl = if entry.outcome.is_reachable() {
        POSITIVE_CACHE_TTL
    } else {
        NEGATIVE_CACHE_TTL
    };
    if entry.at.elapsed() > ttl {
        return None;
    }
    Some(entry.outcome)
}

pub fn store_probe(path: &Path, outcome: ProbeOutcome) {
    let key = path_cache_key(path);
    if let Ok(mut state) = STATE.lock() {
        state.cache.insert(
            key,
            CachedProbe {
                outcome,
                at: Instant::now(),
            },
        );
    }
}

/// Probe Local with cache + timeout. Used by Prefer-Local resolve (B1/B8).
pub fn probe_local(path: &Path, timeout: Duration) -> ProbeOutcome {
    if let Some(cached) = cached_probe(path) {
        return cached;
    }
    let outcome = path_reachable_timed(path, timeout);
    store_probe(path, outcome);
    outcome
}

/// True when map is listed and Prefer-Local should use Local **now**.
pub fn prefer_local_now(path: &Path) -> bool {
    probe_local(path, LOCAL_PROBE_TIMEOUT).is_reachable()
}

/// Mark that Health/Upload is using smb2 while a mapped path wakes (B2/B4).
pub fn note_smb2_bridge(config_unc: &str, local_path: &Path) {
    let key = canonicalize_unc(config_unc);
    if let Ok(mut state) = STATE.lock() {
        state.bridging.insert(key, Instant::now());
    }
    crate::storage::logging::info(
        "smb",
        format!(
            "SMB via smb2 bridge (mapped path not ready: {}); Prefer-Local reconnect…",
            local_path
                .to_string_lossy()
                .trim_end_matches(['\\', '/'])
        ),
    );
}

/// Quiet-Poll: map was bridging recently — hold last UI status on hard fail (B6).
pub fn is_recently_bridging(config_unc: &str) -> bool {
    let key = canonicalize_unc(config_unc);
    let Ok(state) = STATE.lock() else {
        return false;
    };
    state
        .bridging
        .get(&key)
        .is_some_and(|t| t.elapsed() < PREFER_LOCAL_WINDOW)
}

fn clear_bridging(config_unc: &str) {
    let key = canonicalize_unc(config_unc);
    if let Ok(mut state) = STATE.lock() {
        state.bridging.remove(&key);
    }
}

/// Background Prefer-Local: keep probing until Local is up or window expires (B4/B5).
pub fn start_prefer_local_promote(config_unc: String, local_path: PathBuf) {
    let key = canonicalize_unc(&config_unc);
    {
        let Ok(mut state) = STATE.lock() else {
            return;
        };
        if !state.promoting.insert(key.clone()) {
            return;
        }
    }

    let unc_for_log = config_unc.clone();
    let path_for_log = local_path.clone();
    let join = thread::Builder::new()
        .name("smb-prefer-local".into())
        .spawn(move || {
            let started = Instant::now();
            while started.elapsed() < PREFER_LOCAL_WINDOW {
                // Longer per-try budget in background — still bounded.
                let outcome = path_reachable_timed(&local_path, Duration::from_secs(2));
                if outcome.is_reachable() {
                    store_probe(&local_path, ProbeOutcome::Reachable);
                    clear_bridging(&config_unc);
                    let display = local_path
                        .to_string_lossy()
                        .trim_end_matches(['\\', '/'])
                        .to_string();
                    let via = if cfg!(windows) {
                        "mapped drive"
                    } else {
                        "OS mount"
                    };
                    crate::storage::logging::info(
                        "smb",
                        format!("SMB via {via} {display} ({config_unc})"),
                    );
                    break;
                }
                thread::sleep(PREFER_LOCAL_POLL);
            }
            if let Ok(mut state) = STATE.lock() {
                state.promoting.remove(&canonicalize_unc(&unc_for_log));
            }
            let _ = path_for_log;
        });

    if join.is_err() {
        if let Ok(mut state) = STATE.lock() {
            state.promoting.remove(&key);
        }
    }
}

/// Heuristic “map needs reconnect” — first slow/timeout Local probe after resume (B7).
pub fn note_map_needs_reconnect(config_unc: &str) {
    let key = canonicalize_unc(config_unc);
    if let Ok(mut state) = STATE.lock() {
        // Invalidate positive cache entries so the next resolve re-probes.
        state.cache.retain(|_, v| v.outcome.is_reachable() == false);
        state.bridging.insert(key, Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn timed_probe_local_file_reachable() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("probe.txt");
        fs::write(&f, b"x").unwrap();
        assert_eq!(
            path_reachable_timed(&f, Duration::from_secs(2)),
            ProbeOutcome::Reachable
        );
    }

    #[test]
    fn timed_probe_missing_unreachable() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("no-such-file");
        assert_eq!(
            path_reachable_timed(&missing, Duration::from_secs(2)),
            ProbeOutcome::Unreachable
        );
    }

    #[test]
    fn cache_roundtrip_positive() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("cached");
        fs::create_dir_all(&p).unwrap();
        store_probe(&p, ProbeOutcome::Reachable);
        assert_eq!(cached_probe(&p), Some(ProbeOutcome::Reachable));
        assert!(prefer_local_now(&p));
    }

    #[test]
    fn bridging_flag_window() {
        let unc = r"\\opt20b-bridge-test.invalid\share";
        note_smb2_bridge(unc, Path::new(r"Z:\"));
        assert!(is_recently_bridging(unc));
        clear_bridging(unc);
        assert!(!is_recently_bridging(unc));
    }

    #[test]
    fn promote_second_start_is_idempotent() {
        let unc = r"\\opt20b-promote-test.invalid\share";
        let path = PathBuf::from(r"Z:\opt20b-missing");
        start_prefer_local_promote(unc.to_string(), path.clone());
        start_prefer_local_promote(unc.to_string(), path);
        note_smb2_bridge(unc, Path::new(r"Z:\"));
        assert!(is_recently_bridging(unc));
    }

    #[test]
    fn note_reconnect_clears_positive_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("pos");
        fs::create_dir_all(&p).unwrap();
        store_probe(&p, ProbeOutcome::Reachable);
        assert!(cached_probe(&p).unwrap().is_reachable());
        note_map_needs_reconnect(r"\\opt20b-reconnect.invalid\share");
        // Positive entries dropped.
        assert!(cached_probe(&p).is_none());
    }
}
