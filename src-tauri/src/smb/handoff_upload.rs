//! Handoff lifecycle around server upload (ready after success, cancel + cleanup on abort).

use std::path::Path;

use crate::bridge::{maybe_notify_handoff_cancel, maybe_notify_handoff_ready};
use crate::smb::{cleanup_remote_upload_folder, drain_smb_staging_gc};
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
/// Staged uploads already enqueue deferred GC inside `upload_smb`. This still
/// tries an explicit `staging_root` (when known) plus the final job name
/// (legacy / promote races), then drains the GC queue once.
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
        if let Err(e) =
            crate::smb::client::cleanup_staging_path(server_url, login, password, root).await
        {
            logging::warn(
                "smb",
                format!("Staging-Aufräumen nach Upload-Abbruch: {e}"),
            );
        } else {
            logging::info("smb", format!("Staging aufgeräumt: {root}"));
        }
    }

    if let Err(e) =
        cleanup_remote_upload_folder(local_path, server_url, login, password).await
    {
        logging::warn(
            "smb",
            format!("Remote-Aufräumen nach Upload-Abbruch: {e}"),
        );
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

    let cleared = drain_smb_staging_gc(login, password).await;
    if cleared > 0 {
        logging::info(
            "smb",
            format!("Staging-GC: {cleared} Ordner nachträglich entfernt"),
        );
    }

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
