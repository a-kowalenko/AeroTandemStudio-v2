//! OPT-22A: Quiet-Poll / Bridge Session-Economy.
//!
//! Quiet health ticks must not spam `SessionSetup` against Win11 LanmanServer
//! (~20 session SKU limit). Prefer Local when mapped; skip smb2 while Prefer-
//! Local bridge is active; backoff smb2-only Quiet after OK / Connect-Fail.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::reconnect::is_recently_bridging;
use super::windows_mapping::canonicalize_unc;

/// After a successful Quiet smb2 check, skip further Quiet connects this long.
pub const QUIET_OK_BACKOFF: Duration = Duration::from_secs(180);
/// Generic Quiet connect / share failure backoff.
pub const QUIET_FAIL_BACKOFF: Duration = Duration::from_secs(90);
/// Host rejected SessionSetup (`STATUS_REQUEST_NOT_ACCEPTED`) — longer cool-down.
pub const QUIET_REJECTED_BACKOFF: Duration = Duration::from_secs(120);
/// Do not re-log the same skip reason more often than this.
const SKIP_LOG_MIN_INTERVAL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietSkipReason {
    Bridging,
    Backoff,
}

impl QuietSkipReason {
    pub fn as_log_tag(self) -> &'static str {
        match self {
            Self::Bridging => "bridging",
            Self::Backoff => "backoff",
        }
    }
}

#[derive(Debug, Clone)]
struct BackoffEntry {
    until: Instant,
}

#[derive(Debug, Default)]
struct QuietBudgetState {
    /// Canonical UNC → Quiet smb2 backoff deadline.
    backoff: HashMap<String, BackoffEntry>,
    /// Last skip log: UNC → (reason tag, when).
    last_skip_log: HashMap<String, (String, Instant)>,
}

static STATE: Lazy<Mutex<QuietBudgetState>> =
    Lazy::new(|| Mutex::new(QuietBudgetState::default()));

fn now() -> Instant {
    Instant::now()
}

/// Whether Quiet-Poll should **not** open a new smb2 SessionSetup for `config_unc`.
pub fn should_skip_quiet_smb2(config_unc: &str) -> Option<QuietSkipReason> {
    if is_recently_bridging(config_unc) {
        return Some(QuietSkipReason::Bridging);
    }
    let key = canonicalize_unc(config_unc);
    let Ok(state) = STATE.lock() else {
        return None;
    };
    let entry = state.backoff.get(&key)?;
    if entry.until > now() {
        Some(QuietSkipReason::Backoff)
    } else {
        None
    }
}

/// Record a successful Quiet (or loud) smb2 health check — Quiet backs off.
pub fn note_quiet_smb2_ok(config_unc: &str) {
    set_backoff(config_unc, QUIET_OK_BACKOFF);
}

/// Record a failed Quiet smb2 attempt — backoff by error class.
pub fn note_quiet_smb2_fail(config_unc: &str, message: &str) {
    let backoff = if is_session_rejected(message) {
        QUIET_REJECTED_BACKOFF
    } else {
        QUIET_FAIL_BACKOFF
    };
    set_backoff(config_unc, backoff);
}

fn set_backoff(config_unc: &str, duration: Duration) {
    let key = canonicalize_unc(config_unc);
    if let Ok(mut state) = STATE.lock() {
        state.backoff.insert(
            key,
            BackoffEntry {
                until: now() + duration,
            },
        );
    }
}

pub fn is_session_rejected(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("request_not_accepted")
        || lower.contains("status_request_not_accepted")
        || (lower.contains("session setup") && lower.contains("not_accepted"))
}

/// Rate-limited log when Quiet skips SessionSetup (A5 — no spam every 45s).
pub fn log_quiet_skip(config_unc: &str, reason: QuietSkipReason) {
    let key = canonicalize_unc(config_unc);
    let tag = reason.as_log_tag().to_string();
    let should_log = {
        let Ok(mut state) = STATE.lock() else {
            return;
        };
        let now = now();
        let log = match state.last_skip_log.get(&key) {
            Some((prev_tag, at)) if prev_tag == &tag && at.elapsed() < SKIP_LOG_MIN_INTERVAL => {
                false
            }
            _ => true,
        };
        if log {
            state
                .last_skip_log
                .insert(key.clone(), (tag.clone(), now));
        }
        log
    };
    if should_log {
        crate::storage::logging::info(
            "smb",
            format!("SMB quiet skip ({tag}) ({key})"),
        );
    }
}

/// Soft-hold result when Quiet skips smb2 (UI keeps last phase).
pub fn quiet_skip_result(reason: QuietSkipReason) -> (bool, String, bool) {
    let message = match reason {
        QuietSkipReason::Bridging => {
            "SMB Quiet: Prefer-Local reconnection — kein neues SessionSetup".to_string()
        }
        QuietSkipReason::Backoff => {
            "SMB Quiet: Session-Backoff aktiv — Status gehalten".to_string()
        }
    };
    (false, message, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smb::reconnect::{clear_bridging_for_test, note_smb2_bridge};
    use std::path::Path;
    use std::thread;

    fn unique_unc(label: &str) -> String {
        format!(
            r"\\opt22a-{label}-{}.invalid\share",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn bridging_skips_quiet_smb2() {
        let unc = unique_unc("bridge");
        clear_bridging_for_test(&unc);
        assert!(should_skip_quiet_smb2(&unc).is_none());
        note_smb2_bridge(&unc, Path::new(r"Z:\"));
        assert_eq!(
            should_skip_quiet_smb2(&unc),
            Some(QuietSkipReason::Bridging)
        );
        clear_bridging_for_test(&unc);
        assert!(should_skip_quiet_smb2(&unc).is_none());
    }

    #[test]
    fn backoff_after_ok() {
        let unc = unique_unc("ok");
        clear_bridging_for_test(&unc);
        assert!(should_skip_quiet_smb2(&unc).is_none());
        note_quiet_smb2_ok(&unc);
        assert_eq!(
            should_skip_quiet_smb2(&unc),
            Some(QuietSkipReason::Backoff)
        );
    }

    #[test]
    fn backoff_after_fail() {
        let unc = unique_unc("fail");
        clear_bridging_for_test(&unc);
        note_quiet_smb2_fail(&unc, "connection refused");
        assert_eq!(
            should_skip_quiet_smb2(&unc),
            Some(QuietSkipReason::Backoff)
        );
    }

    #[test]
    fn rejected_session_detected() {
        assert!(is_session_rejected(
            "Protocol error: STATUS_REQUEST_NOT_ACCEPTED during SessionSetup"
        ));
        assert!(is_session_rejected("request_not_accepted"));
        assert!(!is_session_rejected("connection refused"));
    }

    #[test]
    fn quiet_skip_result_is_soft_hold() {
        let (ok, _msg, soft) = quiet_skip_result(QuietSkipReason::Bridging);
        assert!(!ok);
        assert!(soft);
        let (ok2, _, soft2) = quiet_skip_result(QuietSkipReason::Backoff);
        assert!(!ok2);
        assert!(soft2);
    }

    #[test]
    fn skip_log_rate_limited() {
        let unc = unique_unc("log");
        // First log should fire; second immediate should be suppressed (no panic).
        log_quiet_skip(&unc, QuietSkipReason::Backoff);
        log_quiet_skip(&unc, QuietSkipReason::Backoff);
        // Different reason may log again.
        log_quiet_skip(&unc, QuietSkipReason::Bridging);
    }

    #[test]
    fn backoff_expires() {
        // Direct short backoff for test — insert via set_backoff with tiny duration
        // is private; simulate by setting and sleeping past a custom entry.
        let unc = unique_unc("expire");
        let key = canonicalize_unc(&unc);
        {
            let mut state = STATE.lock().unwrap();
            state.backoff.insert(
                key,
                BackoffEntry {
                    until: Instant::now() + Duration::from_millis(30),
                },
            );
        }
        assert_eq!(
            should_skip_quiet_smb2(&unc),
            Some(QuietSkipReason::Backoff)
        );
        thread::sleep(Duration::from_millis(50));
        assert!(should_skip_quiet_smb2(&unc).is_none());
    }
}
