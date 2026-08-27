//! Handoff lifecycle around server upload (ready after success, cancel + cleanup on abort).

use std::path::Path;

use crate::bridge::{maybe_notify_handoff_cancel, maybe_notify_handoff_ready};
use crate::smb::{cleanup_remote_upload_folder, spawn_smb_staging_gc};
use crate::storage::config::AppConfig;
use crate::storage::logging;
use crate::storage::vorgang_history::VorgangHistoryStore;
use crate::video::ffmpeg::{is_cancelled, is_upload_slot_cancelled, WORKFLOW_CANCELLED};

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct HandoffUploadContext {
    pub correlation_id: Option<String>,
    pub folder_name: Option<String>,
}

impl HandoffUploadContext {
    pub fn correlation_id(&self) -> Option<&str> {
        self.correlation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn folder_name(&self) -> Option<&str> {
        self.folder_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// Notify AMS after a successful upload (`handoff/ready`).
pub async fn notify_handoff_after_upload(
    config: &AppConfig,
    handoff: &HandoffUploadContext,
) {
    let Some(cid) = handoff.correlation_id() else {
        return;
    };
    match maybe_notify_handoff_ready(config, cid, handoff.folder_name()).await {
        Ok(Some(_)) => logging::info(
            "bridge",
            format!("AMS handoff/ready nach Upload (correlation_id={cid})"),
        ),
        Ok(None) => {}
        Err(e) => logging::warn("bridge", format!("handoff/ready nach Upload: {e}")),
    }
}

/// On upload abort: remote cleanup + optional AMS cancel (best effort).
///
/// Staging delete is already scheduled inside `upload_smb` (`schedule_staging_gc`).
/// Here we only best-effort-remove a leftover **final** job name (legacy) and
/// kick a non-blocking GC pass — never stall Cancel-UX on 8× sharing retries.
pub async fn abort_handoff_upload(
    config: &AppConfig,
    local_path: &Path,
    handoff: &HandoffUploadContext,
    server_url: &str,
    login: &str,
    password: &str,
    staging_root: Option<&str>,
) {
    if let Some(root) = staging_root.map(str::trim).filter(|s| !s.is_empty()) {
        logging::info(
            "smb",
            format!("Staging-GC geplant nach Abbruch: {root}"),
        );
    }

    // Final job name usually does not exist (staging); one quick attempt is enough.
    if let Err(e) =
        cleanup_remote_upload_folder(local_path, server_url, login, password).await
    {
        let low = e.to_ascii_lowercase();
        if !(low.contains("not_found")
            || low.contains("no such")
            || low.contains("sharing_violation")
            || low.contains("directory_not_empty"))
        {
            logging::warn(
                "smb",
                format!("Remote-Aufräumen nach Upload-Abbruch: {e}"),
            );
        }
    } else {
        logging::info(
            "smb",
            format!(
                "Remote-Aufräumen nach Upload-Abbruch: {}",
                handoff
                    .folder_name()
                    .map(str::to_string)
                    .unwrap_or_else(|| local_path.display().to_string())
            ),
        );
    }

    spawn_smb_staging_gc(login, password);

    let Some(cid) = handoff.correlation_id() else {
        return;
    };
    match maybe_notify_handoff_cancel(
        config,
        cid,
        handoff.folder_name(),
        Some(WORKFLOW_CANCELLED),
    )
    .await
    {
        Ok(Some(_)) => logging::info(
            "bridge",
            format!("AMS handoff/cancel gesendet (correlation_id={cid})"),
        ),
        Ok(None) => {}
        Err(e) => logging::warn("bridge", format!("handoff/cancel: {e}")),
    }

    // Persist locally so Historie does not stay on "Wartend" / pending after abort
    // (Bridge/Outbox may be gone once the remote folder is cleaned up).
    match VorgangHistoryStore::open_default()
        .and_then(|store| store.mark_ams_handoff_cancelled(cid, WORKFLOW_CANCELLED))
    {
        Ok(()) => logging::info(
            "vorgang_history",
            format!("AMS-Status lokal auf cancelled gesetzt (correlation_id={cid})"),
        ),
        Err(e) => logging::warn(
            "vorgang_history",
            format!("AMS cancelled konnte nicht persistiert werden: {e}"),
        ),
    }
}

pub fn upload_failure_is_cancelled(message: &str) -> bool {
    is_cancelled()
        || is_upload_slot_cancelled()
        || message.trim() == WORKFLOW_CANCELLED
}
