//! OPT-22B: smb2 session pool for Health / GC (+ upload disconnect hook).
//!
//! One reusable Session+Tree per `host:port/share` + login identity. Idle
//! sessions are reaped after [`IDLE_TTL`] so Win11 LanmanServer slots free up.
//! Upload keeps its own session (v1) and invalidates the pool around the job.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use smb2::{SmbClient, Tree};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use super::client::{connect_smb, map_smb_error};
use super::quiet_budget::{self, is_session_rejected};

/// Unused pooled sessions are disconnected after this idle window (B4: 30–60s).
pub const IDLE_TTL: Duration = Duration::from_secs(45);
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Canonical pool key: `host:port/share|login` (password never included / logged).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PoolKey {
    pub host: String,
    pub port: u16,
    pub share: String,
    /// Login identity only (trimmed; empty → guest).
    pub login: String,
}

impl PoolKey {
    pub fn new(host: &str, port: u16, share: &str, login: &str) -> Self {
        Self {
            host: host.trim().to_string(),
            port,
            share: share.trim().to_string(),
            login: normalize_login_identity(login),
        }
    }

    /// Display form without login (safe for logs).
    pub fn share_label(&self) -> String {
        format!("{}:{}/{}", self.host, self.port, self.share)
    }

    pub fn as_storage_key(&self) -> String {
        format!(
            "{}:{}/{}|{}",
            self.host.to_ascii_lowercase(),
            self.port,
            self.share.to_ascii_lowercase(),
            self.login.to_ascii_lowercase()
        )
    }
}

fn normalize_login_identity(login: &str) -> String {
    let t = login.trim();
    if t.is_empty() {
        "guest".into()
    } else {
        t.to_string()
    }
}

struct IdleSession {
    client: SmbClient,
    tree: Tree,
    last_used: Instant,
}

struct PoolSlot {
    /// Exclusive checkout (B7: one connect / use in-flight per key).
    permit: Arc<Semaphore>,
    idle: Mutex<Option<IdleSession>>,
}

impl PoolSlot {
    fn new() -> Self {
        Self {
            permit: Arc::new(Semaphore::new(1)),
            idle: Mutex::new(None),
        }
    }
}

#[derive(Default)]
struct PoolState {
    slots: HashMap<String, Arc<PoolSlot>>,
    /// Test / diagnostics: successful SessionSetup count for this process.
    connect_count: u64,
    /// Test / diagnostics: pool hits (reused idle session).
    hit_count: u64,
}

static POOL: Lazy<Mutex<PoolState>> = Lazy::new(|| Mutex::new(PoolState::default()));

/// Checked-out pooled session. Call [`PooledSession::release`] or
/// [`PooledSession::discard`] when done (Drop discards without await).
pub struct PooledSession {
    key: PoolKey,
    client: Option<SmbClient>,
    tree: Option<Tree>,
    slot: Arc<PoolSlot>,
    _permit: OwnedSemaphorePermit,
    /// If true, Drop will spawn a best-effort discard (not returned to pool).
    return_on_drop: bool,
}

impl PooledSession {
    /// Mutable access to both halves without overlapping `&mut self` borrows.
    pub fn parts_mut(&mut self) -> (&mut SmbClient, &mut Tree) {
        (
            self.client.as_mut().expect("pooled session already taken"),
            self.tree.as_mut().expect("pooled session already taken"),
        )
    }

    /// Return session to the pool for reuse (updates last_used).
    pub async fn release(mut self) {
        self.return_on_drop = false;
        let Some(client) = self.client.take() else {
            return;
        };
        let Some(tree) = self.tree.take() else {
            return;
        };
        let mut idle = self.slot.idle.lock().await;
        *idle = Some(IdleSession {
            client,
            tree,
            last_used: Instant::now(),
        });
        // permit drops with self → next waiter may proceed
    }

    /// Disconnect and drop; do not return to pool (B5 error path).
    pub async fn discard(mut self) {
        self.return_on_drop = false;
        let client = self.client.take();
        let tree = self.tree.take();
        if let (Some(client), Some(tree)) = (client, tree) {
            disconnect_session(client, tree).await;
        }
        let mut idle = self.slot.idle.lock().await;
        *idle = None;
    }
}

impl Drop for PooledSession {
    fn drop(&mut self) {
        if !self.return_on_drop {
            return;
        }
        let client = self.client.take();
        let tree = self.tree.take();
        let slot = Arc::clone(&self.slot);
        if let (Some(client), Some(tree)) = (client, tree) {
            // Best-effort: free host slot without blocking the Drop path.
            tauri::async_runtime::spawn(async move {
                disconnect_session(client, tree).await;
                let mut idle = slot.idle.lock().await;
                *idle = None;
            });
        }
    }
}

async fn disconnect_session(mut client: SmbClient, tree: Tree) {
    let _ = tokio::time::timeout(DISCONNECT_TIMEOUT, client.disconnect_share(&tree)).await;
    drop(tree);
    drop(client);
}

async fn slot_for(storage_key: &str) -> Arc<PoolSlot> {
    let mut state = POOL.lock().await;
    state
        .slots
        .entry(storage_key.to_string())
        .or_insert_with(|| Arc::new(PoolSlot::new()))
        .clone()
}

/// Drop any idle pooled session for this share/login (B3: upload owns its session).
pub async fn invalidate(host: &str, port: u16, share: &str, login: &str) {
    let key = PoolKey::new(host, port, share, login);
    let storage = key.as_storage_key();
    let slot = {
        let state = POOL.lock().await;
        state.slots.get(&storage).cloned()
    };
    let Some(slot) = slot else {
        return;
    };
    // Wait for any in-flight checkout so we tear down the live idle/checked-out
    // path only for idle; checked-out sessions are discarded by their owner.
    let Ok(_permit) = slot.permit.clone().acquire_owned().await else {
        return;
    };
    let taken = {
        let mut idle = slot.idle.lock().await;
        idle.take()
    };
    if let Some(IdleSession { client, tree, .. }) = taken {
        crate::storage::logging::info(
            "smb",
            format!("SMB pool invalidate ({})", key.share_label()),
        );
        disconnect_session(client, tree).await;
    }
}

/// Acquire a pooled session (reuse idle or connect once). Exclusive until release/discard.
pub async fn acquire(
    host: &str,
    port: u16,
    share: &str,
    login: &str,
    password: &str,
) -> Result<PooledSession, String> {
    reap_idle().await;

    let key = PoolKey::new(host, port, share, login);
    let storage = key.as_storage_key();
    let slot = slot_for(&storage).await;
    let permit = slot
        .permit
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "SMB-Pool: Semaphor geschlossen".to_string())?;

    // Try idle reuse (still within TTL after reap).
    {
        let mut idle = slot.idle.lock().await;
        if let Some(session) = idle.take() {
            if session.last_used.elapsed() < IDLE_TTL {
                drop(idle);
                {
                    let mut state = POOL.lock().await;
                    state.hit_count = state.hit_count.saturating_add(1);
                }
                crate::storage::logging::info(
                    "smb",
                    format!("SMB pool hit ({})", key.share_label()),
                );
                return Ok(PooledSession {
                    key,
                    client: Some(session.client),
                    tree: Some(session.tree),
                    slot,
                    _permit: permit,
                    return_on_drop: true,
                });
            }
            // Expired between reap and take — disconnect before fresh connect.
            drop(idle);
            disconnect_session(session.client, session.tree).await;
        }
    }

    crate::storage::logging::info(
        "smb",
        format!("SMB pool miss — connect ({})", key.share_label()),
    );

    let mut client = match connect_smb(host, port, login, password).await {
        Ok(c) => c,
        Err(e) => {
            note_pool_connect_fail(host, share, &e);
            return Err(e);
        }
    };
    let tree = match client.connect_share(share).await {
        Ok(t) => t,
        Err(e) => {
            let msg = map_smb_error(&e.to_string(), share);
            note_pool_connect_fail(host, share, &msg);
            drop(client);
            return Err(msg);
        }
    };

    {
        let mut state = POOL.lock().await;
        state.connect_count = state.connect_count.saturating_add(1);
    }

    Ok(PooledSession {
        key,
        client: Some(client),
        tree: Some(tree),
        slot,
        _permit: permit,
        return_on_drop: true,
    })
}

fn note_pool_connect_fail(host: &str, share: &str, message: &str) {
    // Share Slice A Quiet backoff for reject / transport failures (B5).
    let unc = format!(r"\\{host}\{share}");
    if is_session_rejected(message)
        || message.to_ascii_lowercase().contains("nicht erreichbar")
        || message.to_ascii_lowercase().contains("timed out")
        || message.to_ascii_lowercase().contains("timeout")
        || message.to_ascii_lowercase().contains("connection refused")
    {
        quiet_budget::note_quiet_smb2_fail(&unc, message);
    }
}

/// Disconnect idle sessions past [`IDLE_TTL`] (B4). Called from acquire.
pub async fn reap_idle() {
    let slots: Vec<(String, Arc<PoolSlot>)> = {
        let state = POOL.lock().await;
        state
            .slots
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect()
    };

    for (storage_key, slot) in slots {
        // Non-blocking: skip slots currently checked out.
        let Ok(_permit) = slot.permit.clone().try_acquire_owned() else {
            continue;
        };
        let expired = {
            let mut idle = slot.idle.lock().await;
            match idle.as_ref() {
                Some(s) if s.last_used.elapsed() >= IDLE_TTL => idle.take(),
                _ => None,
            }
        };
        if let Some(IdleSession { client, tree, .. }) = expired {
            crate::storage::logging::info(
                "smb",
                format!("SMB pool idle reap ({storage_key})"),
            );
            disconnect_session(client, tree).await;
        }
    }
}

/// After a transport / reject error on a checked-out session: discard + Quiet backoff.
pub async fn discard_on_error(session: PooledSession, message: &str) {
    let unc = format!(r"\\{}\{}", session.key.host, session.key.share);
    if is_session_rejected(message)
        || message.to_ascii_lowercase().contains("protocol error")
        || message.to_ascii_lowercase().contains("connection")
        || message.to_ascii_lowercase().contains("broken pipe")
        || message.to_ascii_lowercase().contains("reset")
    {
        quiet_budget::note_quiet_smb2_fail(&unc, message);
    }
    session.discard().await;
}

/// Hard-drop an owned (non-pooled) upload session: `disconnect_share` then Drop (B6).
pub async fn disconnect_owned(mut client: SmbClient, tree: Tree) {
    crate::storage::logging::info("smb", "SMB session disconnect (upload)");
    let _ = tokio::time::timeout(DISCONNECT_TIMEOUT, client.disconnect_share(&tree)).await;
    drop(tree);
    drop(client);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_key_excludes_password_and_normalizes() {
        let a = PoolKey::new("Host", 445, "Share", "User");
        let b = PoolKey::new("host", 445, "share", "user");
        assert_eq!(a.as_storage_key(), b.as_storage_key());
        assert!(!a.as_storage_key().contains("secret"));
        assert_eq!(a.share_label(), "Host:445/Share");
        let guest = PoolKey::new("h", 445, "s", "  ");
        assert_eq!(guest.login, "guest");
    }

    #[test]
    fn idle_ttl_is_in_spec_window() {
        assert!(IDLE_TTL >= Duration::from_secs(30));
        assert!(IDLE_TTL <= Duration::from_secs(60));
    }

    #[test]
    fn pool_key_differs_by_login() {
        let a = PoolKey::new("h", 445, "s", "alice");
        let b = PoolKey::new("h", 445, "s", "bob");
        assert_ne!(a.as_storage_key(), b.as_storage_key());
    }

    #[tokio::test]
    async fn invalidate_empty_is_noop() {
        invalidate("opt22b-no-such-host.invalid", 445, "share", "user").await;
    }

    #[tokio::test]
    async fn pool_stats_start_finite() {
        let state = POOL.lock().await;
        // Just ensure lock works; counts are process-global so only check they don't panic.
        let _ = state.connect_count;
        let _ = state.hit_count;
    }

    /// Fake idle bookkeeping: expired sessions are taken by reap-style logic.
    #[test]
    fn idle_session_expiry_predicate() {
        let fresh = Instant::now();
        assert!(fresh.elapsed() < IDLE_TTL);
        let stale = Instant::now() - IDLE_TTL - Duration::from_secs(1);
        assert!(stale.elapsed() >= IDLE_TTL);
    }

    #[test]
    fn discard_on_error_detects_reject_via_quiet_budget() {
        assert!(is_session_rejected(
            "Protocol error: STATUS_REQUEST_NOT_ACCEPTED during SessionSetup"
        ));
    }
}
