//! OPT-22C: Host-Mutex — serialize writing Transfer + GC per SMB host.
//!
//! Against the same Filehost at most one writing pipeline (Vorgang-Upload **or**
//! SD-Server-Backup) may hold an smb2 session; Staging-GC waits for the same
//! lock instead of opening a parallel `connect_smb`. Different hosts may run
//! in parallel. Local targets skip the mutex (no smb2 slot).

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

static HOST_LOCKS: Lazy<Mutex<HashMap<String, Arc<Semaphore>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Canonical host key from a parsed SMB host (no DNS lookup).
///
/// Port is not part of the key — Backup and Primary on the same machine share
/// one mutex even when shares differ.
pub fn canonical_host_key(host: &str) -> String {
    let trimmed = host
        .trim()
        .trim_matches(|c| c == '\\' || c == '/')
        .trim();
    // Drop bracketed IPv6 form `[::1]` → `::1` for stable keys.
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    // If a caller passes `host:port`, keep only the host part (IPv4 / name).
    let without_port = if unbracketed.matches(':').count() == 1 {
        unbracketed
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(unbracketed)
    } else {
        unbracketed
    };
    without_port.to_ascii_lowercase()
}

/// Local FS targets do not consume an smb2 host slot (C6).
#[allow(dead_code)] // Predicate for callers / tests; Local never enters `upload_smb`.
pub fn smb_target_needs_host_lock(is_smb: bool) -> bool {
    is_smb
}

/// RAII permit — released on Drop (success / cancel / fail).
pub struct HostLockGuard {
    key: String,
    _permit: OwnedSemaphorePermit,
}

impl HostLockGuard {
    #[allow(dead_code)] // Used by unit tests + diagnostics.
    pub fn key(&self) -> &str {
        &self.key
    }
}

impl Drop for HostLockGuard {
    fn drop(&mut self) {
        // OwnedSemaphorePermit releases the slot; key retained for diagnostics.
        let _ = self.key.as_str();
    }
}

async fn semaphore_for(key: &str) -> Arc<Semaphore> {
    let mut map = HOST_LOCKS.lock().await;
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(1)))
        .clone()
}

/// Wait for exclusive host access (Transfer or GC). Logs once when blocked.
pub async fn acquire(host: &str) -> HostLockGuard {
    let key = canonical_host_key(host);
    let sem = semaphore_for(&key).await;
    match sem.clone().try_acquire_owned() {
        Ok(permit) => HostLockGuard {
            key,
            _permit: permit,
        },
        Err(_) => {
            crate::storage::logging::info(
                "smb",
                format!("SMB host busy, waiting… ({key})"),
            );
            let permit = sem
                .acquire_owned()
                .await
                .expect("SMB host lock semaphore closed");
            HostLockGuard {
                key,
                _permit: permit,
            }
        }
    }
}

/// Non-blocking acquire — `None` if another Transfer/GC holds the host.
///
/// Prefer [`acquire`] for Transfer/GC; `try_acquire` is for tests and callers
/// that must not queue behind a long upload.
#[allow(dead_code)]
pub async fn try_acquire(host: &str) -> Option<HostLockGuard> {
    let key = canonical_host_key(host);
    let sem = semaphore_for(&key).await;
    sem.try_acquire_owned().ok().map(|permit| HostLockGuard {
        key,
        _permit: permit,
    })
}

/// Whether `host` currently has no free permit (best-effort; races possible).
#[cfg(test)]
pub async fn is_busy(host: &str) -> bool {
    let key = canonical_host_key(host);
    let map = HOST_LOCKS.lock().await;
    match map.get(&key) {
        Some(sem) => sem.available_permits() == 0,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn canonical_host_normalizes_case_and_slashes() {
        assert_eq!(canonical_host_key(r"\\AMS-PC\"), "ams-pc");
        assert_eq!(canonical_host_key("AMS-PC"), "ams-pc");
        assert_eq!(canonical_host_key("ams-pc:445"), "ams-pc");
        assert_eq!(canonical_host_key("[::1]"), "::1");
    }

    #[test]
    fn same_host_key_ignores_share_and_port() {
        // Port stripped; share is never part of the key.
        assert_eq!(canonical_host_key("nas.local:445"), canonical_host_key("NAS.LOCAL"));
    }

    #[test]
    fn local_targets_skip_mutex() {
        assert!(!smb_target_needs_host_lock(false));
        assert!(smb_target_needs_host_lock(true));
    }

    #[tokio::test]
    async fn same_host_serializes() {
        let host = "opt22c-serial.invalid";
        let first = acquire(host).await;
        assert!(is_busy(host).await);

        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
        let second = tokio::spawn(async move {
            let _guard = acquire(host).await;
            let _ = tx.send(()).await;
        });

        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(rx.try_recv().is_err(), "second acquire must wait");

        drop(first);
        tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .expect("second waiter timed out")
            .expect("second task panicked");
        assert!(rx.try_recv().is_ok());
    }

    #[tokio::test]
    async fn different_hosts_parallel() {
        let a = acquire("opt22c-host-a.invalid").await;
        // Must not block behind host-a.
        let b = tokio::time::timeout(
            Duration::from_millis(200),
            acquire("opt22c-host-b.invalid"),
        )
        .await
        .expect("different host must acquire in parallel");
        assert_ne!(a.key(), b.key());
        drop(a);
        drop(b);
    }

    #[tokio::test]
    async fn try_acquire_none_while_held() {
        let host = "opt22c-try.invalid";
        let _held = acquire(host).await;
        assert!(try_acquire(host).await.is_none());
    }

    #[tokio::test]
    async fn cancel_drop_releases_for_waiter() {
        let host = "opt22c-cancel.invalid";
        let guard = acquire(host).await;
        // Simulate cancel/fail path: Drop releases without explicit unlock.
        drop(guard);
        let next = tokio::time::timeout(Duration::from_millis(200), acquire(host))
            .await
            .expect("lock must be free after Drop");
        drop(next);
    }
}
