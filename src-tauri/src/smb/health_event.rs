//! OPT-23E: piggyback SMB health from Upload / Backup / GC.
//!
//! A finished transfer already proved (or disproved) the server. The UI applies
//! `smb-health` and resets the Quiet poll instead of opening another session.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::quiet_budget::{self, is_login_or_share_failure, is_server_unreachable};

pub const SMB_HEALTH_EVENT: &str = "smb-health";
pub const SMB_HEALTH_OK_MESSAGE: &str = "Server erreichbar";

#[derive(Debug, Clone, Serialize)]
pub struct SmbHealthEvent {
    pub ok: bool,
    pub host: String,
    pub message: String,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
}

/// Record Login/Share stickiness and emit `smb-health` when the app is up.
pub fn publish(ok: bool, host: &str, share: &str, message: &str) {
    let host = host.trim();
    if host.is_empty() {
        return;
    }
    if ok {
        quiet_budget::clear_loud_auth_failure(host, share);
    } else if is_login_or_share_failure(message) {
        quiet_budget::note_loud_auth_failure(host, share, message);
    }
    let message = if ok {
        SMB_HEALTH_OK_MESSAGE.to_string()
    } else {
        message.to_string()
    };
    crate::storage::logging::info(
        "smb",
        format!(
            "SMB health piggyback {} ({host})",
            if ok { "ok" } else { "fail" }
        ),
    );
    let Some(app) = APP.get() else {
        return;
    };
    let _ = app.emit(
        SMB_HEALTH_EVENT,
        &SmbHealthEvent {
            ok,
            host: host.to_string(),
            message,
        },
    );
}

/// Staging-GC outcome → health. A delete race after a live session is still OK.
pub fn publish_gc(host: &str, share: &str, outcome: &Result<(), String>) {
    match outcome {
        Ok(()) => publish(true, host, share, SMB_HEALTH_OK_MESSAGE),
        Err(message) if session_reached_server(message) => {
            publish(true, host, share, SMB_HEALTH_OK_MESSAGE);
        }
        Err(message) => publish(false, host, share, message),
    }
}

fn session_reached_server(message: &str) -> bool {
    if is_login_or_share_failure(message) || is_server_unreachable(message) {
        return false;
    }
    let lower = message.to_ascii_lowercase();
    lower.contains("sharing_violation")
        || lower.contains("directory_not_empty")
        || lower.contains("noch vorhanden")
        || lower.contains("not_found")
        || lower.contains("no such file")
        || lower.contains("no_such_file")
        || lower.contains("object_name_not_found")
        || lower.contains("does not exist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gc_sharing_violation_reached_server() {
        assert!(session_reached_server("STATUS_SHARING_VIOLATION"));
        assert!(session_reached_server(
            "Remote-Ordner noch vorhanden nach Löschen: jobs/.ats_staging/x"
        ));
    }

    #[test]
    fn gc_auth_and_timeout_did_not_reach() {
        assert!(!session_reached_server(
            "Verbindung fehlgeschlagen: Ungültiger Benutzername oder Passwort."
        ));
        assert!(!session_reached_server(
            "Server nicht erreichbar (Zeitüberschreitung)."
        ));
    }
}
