//! OPT-22C: Host-Mutex — serialize writing Transfer + GC per SMB host.
//!
//! Against the same Filehost at most one writing pipeline (Vorgang-Upload **or**
//! SD-Server-Backup) may hold an smb2 session; Staging-GC waits for the same
//! lock instead of opening a parallel `connect_smb`. Health checks use
//! [`gate_health_connect`] so they do not SessionSetup beside that pipeline.
//! Different hosts may run in parallel. Local targets skip the mutex (no smb2 slot).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

/// Loud health waits at most this long for a writing pipeline (OPT-23A A4).
pub const LOUD_HEALTH_LOCK_WAIT: Duration = Duration::from_secs(3);

static HOST_LOCKS: Lazy<Mutex<HashMap<String, Arc<Semaphore>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Canonical host key from a parsed SMB host.
///
/// Uses the OPT-23C alias resolver: a sorted IP set when resolution succeeds,
/// otherwise the normalized string (no port). Backup and Primary on the same
/// machine share one mutex even when the share differs. Unit tests do not
/// resolve (see [`super::host_alias::global`]), so keys stay the normalized
/// spelling unless a caller injects a lookup on [`super::host_alias::HostResolver`].
pub fn canonical_host_key(host: &str) -> String {
    super::host_alias::global().canonical_key(host)
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
            crate::storage::logging::info("smb", format!("SMB host busy, waiting… ({key})"));
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
/// Prefer [`acquire`] for Transfer/GC. Quiet health uses this so a poll does
/// not queue behind a long upload.
pub async fn try_acquire(host: &str) -> Option<HostLockGuard> {
    let key = canonical_host_key(host);
    let sem = semaphore_for(&key).await;
    sem.try_acquire_owned().ok().map(|permit| HostLockGuard {
        key,
        _permit: permit,
    })
}

/// Health may open one pooled session only while it holds the host lock.
pub enum HealthConnectGate {
    /// Lock held. Caller must keep the guard until the pool session is released.
    Ready(HostLockGuard),
    /// Quiet poll: a writer already holds the host. Do not SessionSetup.
    QuietBusy,
    /// Loud check: writer still holds the host after [`LOUD_HEALTH_LOCK_WAIT`].
    /// Do not SessionSetup — the in-flight transfer proves the connection.
    LoudBusy,
}

/// Gate a Health SessionSetup on the host mutex.
///
/// Quiet returns [`HealthConnectGate::QuietBusy`] immediately when Upload,
/// Backup, or GC holds the host. Loud waits up to [`LOUD_HEALTH_LOCK_WAIT`];
/// on timeout it returns [`HealthConnectGate::LoudBusy`] without SessionSetup.
pub async fn gate_health_connect(host: &str, quiet: bool) -> HealthConnectGate {
    if quiet {
        match try_acquire(host).await {
            Some(guard) => HealthConnectGate::Ready(guard),
            None => HealthConnectGate::QuietBusy,
        }
    } else {
        match tokio::time::timeout(LOUD_HEALTH_LOCK_WAIT, acquire(host)).await {
            Ok(guard) => HealthConnectGate::Ready(guard),
            Err(_) => {
                let key = canonical_host_key(host);
                crate::storage::logging::info(
                    "smb",
                    format!("SMB health loud timeout — host busy ({key})"),
                );
                HealthConnectGate::LoudBusy
            }
        }
    }
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
        assert_eq!(
            canonical_host_key("nas.local:445"),
            canonical_host_key("NAS.LOCAL")
        );
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
        let b = tokio::time::timeout(Duration::from_millis(200), acquire("opt22c-host-b.invalid"))
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

    #[tokio::test]
    async fn quiet_health_skips_when_host_busy() {
        let host = "opt22d-quiet-busy.invalid";
        let _held = acquire(host).await;
        match gate_health_connect(host, true).await {
            HealthConnectGate::QuietBusy => {}
            HealthConnectGate::Ready(_) => panic!("quiet must not SessionSetup while host busy"),
            HealthConnectGate::LoudBusy => panic!("quiet must not use the loud timeout"),
        }
    }

    #[tokio::test]
    async fn quiet_health_holds_lock_when_free() {
        let host = "opt22d-quiet-free.invalid";
        let gate = gate_health_connect(host, true).await;
        let HealthConnectGate::Ready(guard) = gate else {
            panic!("quiet must acquire when the host is free");
        };
        assert!(is_busy(host).await);
        drop(guard);
        assert!(!is_busy(host).await);
    }

    #[tokio::test]
    async fn loud_health_waits_until_host_free() {
        let host = "opt22d-loud-wait.invalid";
        let held = acquire(host).await;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
        let waiter = tokio::spawn(async move {
            let gate = gate_health_connect(host, false).await;
            let _ = tx.send(()).await;
            match gate {
                HealthConnectGate::Ready(guard) => drop(guard),
                HealthConnectGate::QuietBusy => panic!("loud must wait, not skip"),
                HealthConnectGate::LoudBusy => {
                    panic!("loud must acquire once the writer drops the lock")
                }
            }
        });

        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            rx.try_recv().is_err(),
            "loud health must wait for the writer"
        );

        drop(held);
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("loud health timed out")
            .expect("loud health task panicked");
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn loud_health_lock_wait_is_three_seconds() {
        assert_eq!(LOUD_HEALTH_LOCK_WAIT, Duration::from_secs(3));
    }

    #[tokio::test]
    async fn loud_health_timeout_returns_loud_busy() {
        let host = "opt23a-loud-busy.invalid";
        let held = acquire(host).await;
        let started = std::time::Instant::now();
        let gate = tokio::time::timeout(
            LOUD_HEALTH_LOCK_WAIT + Duration::from_secs(2),
            gate_health_connect(host, false),
        )
        .await
        .expect("loud gate must return");
        let elapsed = started.elapsed();
        match gate {
            HealthConnectGate::LoudBusy => {}
            HealthConnectGate::Ready(_) => panic!("must not SessionSetup while host stays busy"),
            HealthConnectGate::QuietBusy => panic!("loud path must not use QuietBusy"),
        }
        assert!(
            elapsed >= LOUD_HEALTH_LOCK_WAIT,
            "returned before the loud wait: {elapsed:?}"
        );
        assert!(
            elapsed < LOUD_HEALTH_LOCK_WAIT + Duration::from_secs(2),
            "loud wait ran too long: {elapsed:?}"
        );
        // Dropping the timed-out acquire must not take the permit.
        assert!(is_busy(host).await);
        assert!(try_acquire(host).await.is_none());
        drop(held);
        assert!(try_acquire(host).await.is_some());
    }
}
