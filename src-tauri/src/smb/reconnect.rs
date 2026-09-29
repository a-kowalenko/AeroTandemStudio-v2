//! OPT-20B / OPT-23B: Timed Local-Probe + Prefer-Local / smb2 bridge.
//!
//! Windows mapped drives can block for ~60s on `metadata` while the redirector
//! wakes after standby. This module:
//! - probes Local reachability on **one worker thread per path** (single-flight)
//! - further callers wait for that flight or return [`ProbeOutcome::TimedOut`]
//! - classifies a missing/denied child under a living mapping root as Local
//! - falls back to smb2 as a **bridge** while Prefer-Local reconnect runs
//! - caches recent probe results so resolve + `test_connection` share one probe

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
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
    /// NotFound on a path whose mapping root just probed as alive (OPT-23B).
    Missing,
    /// PermissionDenied — stay on the OS path, do not open smb2 (OPT-23B).
    Denied,
    Unreachable,
    TimedOut,
}

impl ProbeOutcome {
    pub fn is_reachable(self) -> bool {
        matches!(self, Self::Reachable)
    }

    /// OS path is the right target: alive, or classified under a living root.
    pub fn prefers_local(self) -> bool {
        matches!(self, Self::Reachable | Self::Missing | Self::Denied)
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

static STATE: Lazy<Mutex<ReconnectState>> = Lazy::new(|| Mutex::new(ReconnectState::default()));

/// One in-flight OS probe per cache key (OPT-23B). Waiters share the result.
struct Flight {
    result: Mutex<Option<ProbeOutcome>>,
    cv: Condvar,
}

static INFLIGHT: Lazy<Mutex<HashMap<String, Arc<Flight>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn path_cache_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn is_permission_denied(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::PermissionDenied || (cfg!(windows) && err.raw_os_error() == Some(5))
}

/// `metadata` classification. NotFound stays [`ProbeOutcome::Unreachable`] here;
/// [`classify_mapped_path`] promotes that to [`ProbeOutcome::Missing`] only for a
/// child of a living mapping root.
fn probe_metadata(path: &Path) -> ProbeOutcome {
    match std::fs::metadata(path) {
        Ok(_) => ProbeOutcome::Reachable,
        Err(e) if is_permission_denied(&e) => ProbeOutcome::Denied,
        Err(_) => ProbeOutcome::Unreachable,
    }
}

fn inflight_map() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Flight>>> {
    INFLIGHT.lock().unwrap_or_else(|p| p.into_inner())
}

fn begin_flight(key: &str) -> (Arc<Flight>, bool) {
    let mut map = inflight_map();
    if let Some(existing) = map.get(key) {
        return (existing.clone(), false);
    }
    let flight = Arc::new(Flight {
        result: Mutex::new(None),
        cv: Condvar::new(),
    });
    map.insert(key.to_string(), flight.clone());
    (flight, true)
}

fn probe_still_inflight(path: &Path) -> bool {
    let key = path_cache_key(path);
    inflight_map().contains_key(&key)
}

fn finish_flight(key: &str, flight: &Arc<Flight>, outcome: ProbeOutcome) {
    store_probe_key(key, outcome);
    {
        let mut slot = flight.result.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            *slot = Some(outcome);
        }
        flight.cv.notify_all();
    }
    let mut map = inflight_map();
    if map
        .get(key)
        .is_some_and(|existing| Arc::ptr_eq(existing, flight))
    {
        map.remove(key);
    }
}

fn spawn_probe(path: PathBuf, key: String, flight: Arc<Flight>) {
    #[cfg(test)]
    record_spawn(&key);
    let key_for_thread = key.clone();
    let flight_for_thread = flight.clone();
    let spawned = thread::Builder::new()
        .name("smb-local-probe".into())
        .spawn(move || {
            #[cfg(test)]
            if let Some(delay) = test_delay_for(&key_for_thread) {
                thread::sleep(delay);
            }
            let outcome = probe_metadata(&path);
            finish_flight(&key_for_thread, &flight_for_thread, outcome);
        });
    if spawned.is_err() {
        finish_flight(&key, &flight, ProbeOutcome::Unreachable);
    }
}

fn wait_for_flight(flight: &Flight, timeout: Duration) -> ProbeOutcome {
    let deadline = Instant::now() + timeout;
    let mut guard = flight.result.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        if let Some(outcome) = *guard {
            return outcome;
        }
        let now = Instant::now();
        if now >= deadline {
            return ProbeOutcome::TimedOut;
        }
        let remaining = deadline - now;
        match flight.cv.wait_timeout(guard, remaining) {
            Ok((next, status)) => {
                guard = next;
                if status.timed_out() {
                    return guard.unwrap_or(ProbeOutcome::TimedOut);
                }
            }
            Err(poisoned) => {
                let (next, status) = poisoned.into_inner();
                guard = next;
                if status.timed_out() {
                    return guard.unwrap_or(ProbeOutcome::TimedOut);
                }
            }
        }
    }
}

/// Threaded `metadata` with hard timeout — does not block the caller beyond `timeout`.
///
/// OPT-23B: at most one `smb-local-probe` thread per cache key. Further callers
/// wait on that flight (or return [`ProbeOutcome::TimedOut`]) and do not spawn.
pub fn path_reachable_timed(path: &Path, timeout: Duration) -> ProbeOutcome {
    if timeout.is_zero() {
        return probe_metadata(path);
    }

    let key = path_cache_key(path);
    let (flight, leader) = begin_flight(&key);
    if leader {
        spawn_probe(path.to_path_buf(), key, flight.clone());
    }
    wait_for_flight(&flight, timeout)
}

/// Look up a fresh cached probe for `path` (positive or negative TTL).
pub fn cached_probe(path: &Path) -> Option<ProbeOutcome> {
    let key = path_cache_key(path);
    let Ok(state) = STATE.lock() else {
        return None;
    };
    let entry = state.cache.get(&key)?;
    let ttl = if entry.outcome.prefers_local() {
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
    store_probe_key(&path_cache_key(path), outcome);
}

fn store_probe_key(key: &str, outcome: ProbeOutcome) {
    if let Ok(mut state) = STATE.lock() {
        state.cache.insert(
            key.to_string(),
            CachedProbe {
                outcome,
                at: Instant::now(),
            },
        );
    }
}

/// Probe Local with cache + timeout. Used by Prefer-Local resolve (B1/B8).
///
/// A caller that times out while the shared flight is still running does not
/// write [`ProbeOutcome::TimedOut`] over the result the worker publishes later.
pub fn probe_local(path: &Path, timeout: Duration) -> ProbeOutcome {
    if let Some(cached) = cached_probe(path) {
        return cached;
    }
    let outcome = path_reachable_timed(path, timeout);
    if let Some(cached) = cached_probe(path) {
        return cached;
    }
    if !probe_still_inflight(path) {
        store_probe(path, outcome);
    }
    outcome
}

fn paths_equivalent(a: &Path, b: &Path) -> bool {
    path_cache_key(a) == path_cache_key(b)
}

/// Reachability of a listed OS map (OPT-23B).
///
/// The mapping root is probed with the timed single-flight probe. A missing or
/// access-denied child under a living root becomes [`ProbeOutcome::Missing`] or
/// [`ProbeOutcome::Denied`] — both [`ProbeOutcome::prefers_local`] — so the
/// caller stays on the OS path instead of opening smb2.
pub fn classify_mapped_path(root: &Path, full: &Path) -> ProbeOutcome {
    let root_outcome = probe_local(root, LOCAL_PROBE_TIMEOUT);
    if paths_equivalent(root, full) {
        return root_outcome;
    }
    let outcome = match root_outcome {
        ProbeOutcome::Reachable => classify_child(full),
        ProbeOutcome::Denied => ProbeOutcome::Denied,
        other => other,
    };
    store_probe(full, outcome);
    outcome
}

fn classify_child(full: &Path) -> ProbeOutcome {
    match std::fs::metadata(full) {
        Ok(_) => ProbeOutcome::Reachable,
        Err(e) if e.kind() == ErrorKind::NotFound => ProbeOutcome::Missing,
        Err(e) if is_permission_denied(&e) => ProbeOutcome::Denied,
        Err(_) => ProbeOutcome::Unreachable,
    }
}

fn cache_key_under_root(key: &str, root: &str) -> bool {
    if root.is_empty() {
        return false;
    }
    if key == root {
        return true;
    }
    let rest = key.get(root.len()..);
    rest.is_some_and(|rest| key.starts_with(root) && rest.starts_with(['\\', '/']))
}

/// True when map is listed and Prefer-Local should use Local **now**.
pub fn prefer_local_now(path: &Path) -> bool {
    probe_local(path, LOCAL_PROBE_TIMEOUT).is_reachable()
}

/// Mark that Health/Upload is using smb2 while a mapped path wakes (B2/B4).
///
/// OPT-22A: do **not** reset the Prefer-Local window on every Quiet tick — only
/// start (or restart after expiry) so Quiet can skip SessionSetup for the full
/// [`PREFER_LOCAL_WINDOW`].
pub fn note_smb2_bridge(config_unc: &str, local_path: &Path) {
    let key = canonicalize_unc(config_unc);
    let newly_started = {
        let Ok(mut state) = STATE.lock() else {
            return;
        };
        let fresh = match state.bridging.get(&key) {
            Some(t) if t.elapsed() < PREFER_LOCAL_WINDOW => false,
            _ => true,
        };
        if fresh {
            state.bridging.insert(key, Instant::now());
        }
        fresh
    };
    if newly_started {
        crate::storage::logging::info(
            "smb",
            format!(
                "SMB via smb2 bridge (mapped path not ready: {}); Prefer-Local reconnect…",
                local_path.to_string_lossy().trim_end_matches(['\\', '/'])
            ),
        );
    }
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

/// Test helper: drop Prefer-Local bridge flag for `config_unc`.
#[cfg(test)]
pub fn clear_bridging_for_test(config_unc: &str) {
    clear_bridging(config_unc);
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

/// Heuristic “map needs reconnect” — first slow/timeout Local probe after resume.
///
/// OPT-23B: drops cached probes under `local_root` only. Other drives / mounts
/// keep their entries.
pub fn note_map_needs_reconnect(config_unc: &str, local_root: &Path) {
    let key = canonicalize_unc(config_unc);
    let root_key = path_cache_key(local_root);
    if let Ok(mut state) = STATE.lock() {
        state
            .cache
            .retain(|entry, _| !cache_key_under_root(entry, &root_key));
        state.bridging.insert(key, Instant::now());
    }
}

#[cfg(test)]
static PROBE_DELAYS: Lazy<Mutex<HashMap<String, Duration>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
static PROBE_SPAWNS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

#[cfg(test)]
fn test_delay_for(key: &str) -> Option<Duration> {
    PROBE_DELAYS
        .lock()
        .ok()
        .and_then(|map| map.get(key).copied())
}

#[cfg(test)]
fn record_spawn(key: &str) {
    if let Ok(mut spawns) = PROBE_SPAWNS.lock() {
        spawns.push(key.to_string());
    }
}

#[cfg(test)]
fn test_set_probe_delay(path: &Path, delay: Option<Duration>) {
    let key = path_cache_key(path);
    if let Ok(mut map) = PROBE_DELAYS.lock() {
        match delay {
            Some(delay) => {
                map.insert(key, delay);
            }
            None => {
                map.remove(&key);
            }
        }
    }
}

#[cfg(test)]
fn test_reset_spawns() {
    if let Ok(mut spawns) = PROBE_SPAWNS.lock() {
        spawns.clear();
    }
}

#[cfg(test)]
fn test_spawn_count(path: &Path) -> usize {
    let key = path_cache_key(path);
    PROBE_SPAWNS
        .lock()
        .map(|spawns| spawns.iter().filter(|entry| entry.as_str() == key).count())
        .unwrap_or(0)
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
    fn note_smb2_bridge_does_not_reset_window() {
        let unc = r"\\opt22a-bridge-sticky.invalid\share";
        clear_bridging(unc);
        note_smb2_bridge(unc, Path::new(r"Z:\"));
        let started = {
            let state = STATE.lock().unwrap();
            *state
                .bridging
                .get(&canonicalize_unc(unc))
                .expect("bridging started")
        };
        // Second note (Quiet tick) must keep the original Instant.
        note_smb2_bridge(unc, Path::new(r"Z:\"));
        let again = {
            let state = STATE.lock().unwrap();
            *state
                .bridging
                .get(&canonicalize_unc(unc))
                .expect("bridging still set")
        };
        assert_eq!(started, again);
        clear_bridging(unc);
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
    fn note_reconnect_clears_only_local_root_prefix() {
        let root_dir = tempfile::tempdir().unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let base = root_dir.path().join("share");
        let under = base.join("jobs").join("neu");
        let sibling_name = root_dir.path().join("share2");
        let keep = other_dir.path().join("keep");
        let negative = base.join("missing-cached");
        fs::create_dir_all(&under).unwrap();
        fs::create_dir_all(&sibling_name).unwrap();
        fs::create_dir_all(&keep).unwrap();

        store_probe(&base, ProbeOutcome::Reachable);
        store_probe(&under, ProbeOutcome::Reachable);
        store_probe(&negative, ProbeOutcome::Unreachable);
        store_probe(&sibling_name, ProbeOutcome::Reachable);
        store_probe(&keep, ProbeOutcome::Denied);

        let unc = r"\\opt23b-reconnect.invalid\share";
        clear_bridging(unc);
        note_map_needs_reconnect(unc, &base);

        assert!(cached_probe(&base).is_none());
        assert!(cached_probe(&under).is_none());
        assert!(cached_probe(&negative).is_none());
        assert_eq!(cached_probe(&sibling_name), Some(ProbeOutcome::Reachable));
        assert_eq!(cached_probe(&keep), Some(ProbeOutcome::Denied));
        assert!(is_recently_bridging(unc));
        clear_bridging(unc);
    }

    #[test]
    fn missing_child_under_living_root_prefers_local() {
        let tmp = tempfile::tempdir().unwrap();
        let child = tmp.path().join("jobs").join("neu");
        let outcome = classify_mapped_path(tmp.path(), &child);
        assert_eq!(outcome, ProbeOutcome::Missing);
        assert!(outcome.prefers_local());
        assert!(!outcome.is_reachable());
        assert_eq!(cached_probe(&child), Some(ProbeOutcome::Missing));
    }

    #[test]
    fn living_child_under_root_is_reachable() {
        let tmp = tempfile::tempdir().unwrap();
        let child = tmp.path().join("jobs");
        fs::create_dir_all(&child).unwrap();
        assert_eq!(
            classify_mapped_path(tmp.path(), &child),
            ProbeOutcome::Reachable
        );
    }

    #[test]
    fn dead_root_does_not_classify_child_as_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing_root = tmp.path().join("no-such-root");
        let child = missing_root.join("jobs");
        let outcome = classify_mapped_path(&missing_root, &child);
        assert_eq!(outcome, ProbeOutcome::Unreachable);
        assert!(!outcome.prefers_local());
    }

    #[test]
    fn single_flight_second_caller_does_not_spawn() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("flight");
        fs::create_dir_all(&path).unwrap();
        test_set_probe_delay(&path, Some(Duration::from_millis(400)));
        test_reset_spawns();

        let leader_path = path.clone();
        let leader =
            thread::spawn(move || path_reachable_timed(&leader_path, Duration::from_secs(2)));
        let started = Instant::now();
        while test_spawn_count(&path) == 0 && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(test_spawn_count(&path), 1, "leader should have spawned");

        let join_path = path.clone();
        let joiner =
            thread::spawn(move || path_reachable_timed(&join_path, Duration::from_secs(2)));
        let timeout_path = path.clone();
        let timed_out =
            thread::spawn(move || path_reachable_timed(&timeout_path, Duration::from_millis(30)));

        assert_eq!(leader.join().unwrap(), ProbeOutcome::Reachable);
        assert_eq!(joiner.join().unwrap(), ProbeOutcome::Reachable);
        assert_eq!(timed_out.join().unwrap(), ProbeOutcome::TimedOut);
        assert_eq!(
            test_spawn_count(&path),
            1,
            "waiters must join the in-flight probe"
        );
        test_set_probe_delay(&path, None);
    }

    #[test]
    fn permission_denied_outcome_from_metadata_error() {
        let err = std::io::Error::new(ErrorKind::PermissionDenied, "denied");
        assert!(is_permission_denied(&err));
        let not_found = std::io::Error::new(ErrorKind::NotFound, "missing");
        assert!(!is_permission_denied(&not_found));
    }
}
