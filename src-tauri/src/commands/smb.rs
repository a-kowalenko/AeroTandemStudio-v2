//! Tauri commands for SMB server connection & upload.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::config::ConfigState;
use crate::smb::{
    abort_handoff_upload, notify_handoff_after_upload, test_connection,
    upload_failure_is_cancelled, upload_path, ConnectionTestResult, HandoffUploadContext,
    UploadProgress, UploadResult,
};
use crate::storage::logging::{self, file_name};
use crate::video::ffmpeg::{is_upload_cancelled, UploadCancelPolicy, WORKFLOW_CANCELLED};

pub const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
/// Emitted when cancel has stopped the transfer and remote job-root cleanup starts.
pub const UPLOAD_SLOT_PHASE_EVENT: &str = "upload-slot-phase";

#[derive(Debug, Clone, Serialize)]
pub struct UploadSlotPhaseEvent {
    /// `cleanup` while remote job-root removal (+ AMS abort) runs.
    pub phase: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgressEvent {
    pub percent: f64,
    pub current_file: u32,
    pub total_files: u32,
    pub current_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: f64,
    pub filename: String,
    pub status: String,
}

impl From<UploadProgress> for UploadProgressEvent {
    fn from(p: UploadProgress) -> Self {
        let status = if p.percent >= 100.0 {
            "end".into()
        } else if p.current_file == 0 {
            "start".into()
        } else {
            "continue".into()
        };
        Self {
            percent: p.percent,
            current_file: p.current_file,
            total_files: p.total_files,
            current_bytes: p.current_bytes,
            total_bytes: p.total_bytes,
            speed_bps: p.speed_bps,
            filename: p.filename,
            status,
        }
    }
}

/// Optional overrides; defaults come from saved config.
#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct ServerOverrides {
    pub server_url: Option<String>,
    pub server_login: Option<String>,
    pub server_password: Option<String>,
}

#[tauri::command]
pub async fn test_server_connection(
    state: State<'_, ConfigState>,
    overrides: Option<ServerOverrides>,
    // Quiet-Poll (OPT-20B): short Local probe; soft_hold on bridge fail.
    quiet: Option<bool>,
) -> Result<ConnectionTestResult, String> {
    let (url, login, password, auto_mount) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let o = overrides.unwrap_or_default();
        (
            o.server_url.unwrap_or_else(|| cache.server_url.clone()),
            o.server_login.unwrap_or_else(|| cache.server_login.clone()),
            o.server_password
                .unwrap_or_else(|| cache.server_password.clone()),
            cache.smb_auto_mount_enabled,
        )
    };
    logging::info("smb", format!("Server-Test: url={}", url.trim()));
    let result = test_connection(&url, &login, &password, auto_mount, quiet.unwrap_or(false)).await;
    if result.ok {
        logging::info("smb", format!("Server-Test OK: {}", result.message));
    } else if result.soft_hold {
        logging::info(
            "smb",
            format!(
                "Server-Test soft-hold (status unchanged): {}",
                result.message
            ),
        );
    } else {
        logging::warn(
            "smb",
            format!("Server-Test fehlgeschlagen: {}", result.message),
        );
    }
    Ok(result)
}

/// Upload a finished video file or an entire folder to the configured server.
///
/// When `handoff` is set and upload succeeds, sends `handoff/ready` to AMS.
/// On cancel with handoff context, cleans up the remote partial folder and notifies AMS.
#[tauri::command]
pub async fn upload_to_server(
    app: AppHandle,
    state: State<'_, ConfigState>,
    local_path: String,
    overrides: Option<ServerOverrides>,
    handoff: Option<HandoffUploadContext>,
) -> Result<UploadResult, String> {
    let path = PathBuf::from(&local_path);
    if !path.exists() {
        return Err(format!("Lokaler Pfad existiert nicht: {local_path}"));
    }

    let (config, url, login, password, auto_mount) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let o = overrides.unwrap_or_default();
        (
            cache.clone(),
            o.server_url.unwrap_or_else(|| cache.server_url.clone()),
            o.server_login.unwrap_or_else(|| cache.server_login.clone()),
            o.server_password
                .unwrap_or_else(|| cache.server_password.clone()),
            cache.smb_auto_mount_enabled,
        )
    };

    logging::info("smb", format!("Upload start: {}", file_name(&local_path)));

    // Do NOT reset slot cancel here — the frontend clears it when starting a
    // fresh slot job. Resetting at command entry would swallow a cancel that
    // landed between the UI force-cancel and this invoke.
    if is_upload_cancelled(UploadCancelPolicy::SlotOnly) {
        logging::warn("smb", "Upload abgebrochen (bereits vor Start)");
        return Err(WORKFLOW_CANCELLED.into());
    }

    let app_for_progress = app.clone();
    let result = upload_path(
        &path,
        &url,
        &login,
        &password,
        auto_mount,
        UploadCancelPolicy::SlotOnly,
        move |progress| {
            let event = UploadProgressEvent::from(progress);
            let _ = app_for_progress.emit(UPLOAD_PROGRESS_EVENT, &event);
        },
    )
    .await;

    // OPT-23E: a finished smb2 transfer is a health sample. Cancel is not.
    if !upload_failure_is_cancelled(&result.message) {
        if let (Some(host), Some(share)) = (result.smb_host.as_deref(), result.smb_share.as_deref())
        {
            let reached = result.success
                || crate::smb::remote_conflict::is_remote_job_exists_message(&result.message);
            crate::smb::health_event::publish(reached, host, share, &result.message);
        }
    }

    if result.success {
        logging::info(
            "smb",
            format!("Upload fertig: {} → {}", result.message, result.remote_path),
        );
        if let Some(h) = handoff.as_ref().filter(|h| h.correlation_id().is_some()) {
            notify_handoff_after_upload(&config, h).await;
        }
        Ok(result)
    } else {
        if upload_failure_is_cancelled(&result.message) {
            logging::warn("smb", format!("Upload abgebrochen: {}", result.message));
            // Keep the upload slot busy until job-root cleanup finishes so a
            // retry of the same folder cannot race leftover remote files.
            let _ = app.emit(
                UPLOAD_SLOT_PHASE_EVENT,
                &UploadSlotPhaseEvent {
                    phase: "cleanup".into(),
                },
            );
            let h = handoff.unwrap_or_default();
            abort_handoff_upload(
                &config,
                &path,
                &h,
                &url,
                &login,
                &password,
                result.staging_root.as_deref(),
            )
            .await;
        } else if crate::smb::remote_conflict::is_remote_job_exists_message(&result.message) {
            logging::info(
                "smb",
                "Zielordner existiert bereits — Konfliktprüfung".to_string(),
            );
        } else {
            logging::error("smb", format!("Upload fehlgeschlagen: {}", result.message));
        }
        Err(result.message)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteJobConflictDto {
    pub action: String,
    pub reason: String,
    pub folder_name: String,
}

/// Classify an existing remote job folder after `REMOTE_JOB_EXISTS`.
///
/// Does not delete anything. `retry` means the folder is already gone.
#[tauri::command]
pub async fn classify_remote_job_conflict(
    state: State<'_, ConfigState>,
    local_path: String,
    vorgang_id: Option<i64>,
) -> Result<RemoteJobConflictDto, String> {
    let config = crate::commands::config::ensure_ams_bridge_identity(&state)?;
    let local = PathBuf::from(local_path.trim());
    let (job_dir, correlation_id, cached_state, cached_source) =
        load_conflict_context(&local, vorgang_id)?;
    let folder_name = job_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            local
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    let snapshot = match crate::smb::client::snapshot_upload_destination(
        &config.server_url,
        &config.server_login,
        &config.server_password,
        config.smb_auto_mount_enabled,
        &job_dir,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            logging::warn("smb", format!("Remote-Konflikt nicht lesbar: {e}"));
            return Ok(RemoteJobConflictDto {
                action: crate::smb::remote_conflict::ACTION_UNCLEAR.into(),
                reason: crate::smb::remote_conflict::REASON_PROBE_FAILED.into(),
                folder_name,
            });
        }
    };

    let (ams_state, ams_source) =
        resolve_conflict_ams(&config, &correlation_id, &job_dir, &cached_state, &cached_source)
            .await;
    let ams_state = crate::smb::remote_conflict::ams_state_for_conflict(&ams_state, &ams_source);
    let required = read_manifest_paths(&job_dir);
    let manifest_match = crate::smb::remote_conflict::manifest_paths_covered(
        &required,
        &snapshot.relative_files,
    );
    let decision = crate::smb::remote_conflict::classify_remote_job(
        &crate::smb::remote_conflict::RemoteJobFacts {
            folder_present: snapshot.folder_present,
            listed: snapshot.listed,
            truncated: snapshot.truncated,
            has_fertig: snapshot.has_fertig,
            has_processing: snapshot.has_processing,
            manifest_match,
            ams_state,
        },
    );
    logging::info(
        "smb",
        format!(
            "Remote-Konflikt {} → {} ({})",
            folder_name, decision.action, decision.reason
        ),
    );
    Ok(RemoteJobConflictDto {
        action: decision.action.into(),
        reason: decision.reason.into(),
        folder_name,
    })
}

/// Delete the remote job folder named like `local_path` so a confirmed replace can upload again.
#[tauri::command]
pub async fn delete_remote_job_folder(
    state: State<'_, ConfigState>,
    local_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(local_path.trim());
    if path
        .file_name()
        .map(|n| n.to_string_lossy().trim().is_empty())
        .unwrap_or(true)
    {
        return Err("Kein Job-Ordnername".into());
    }
    let (url, login, password, auto_mount) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        (
            cache.server_url.clone(),
            cache.server_login.clone(),
            cache.server_password.clone(),
            cache.smb_auto_mount_enabled,
        )
    };
    logging::warn(
        "smb",
        format!("Remote-Job ersetzen: {}", file_name(&local_path)),
    );
    crate::smb::cleanup_remote_upload_folder(&path, &url, &login, &password, auto_mount).await
}

fn load_conflict_context(
    local: &std::path::Path,
    vorgang_id: Option<i64>,
) -> Result<(PathBuf, String, String, String), String> {
    let store = crate::storage::vorgang_history::VorgangHistoryStore::open_default()
        .map_err(|e| e.to_string())?;
    if let Some(id) = vorgang_id {
        if let Some(entry) = store.get_by_id(id).map_err(|e| e.to_string())? {
            let dir = entry.base_output_dir.trim();
            let job_dir = if dir.is_empty() {
                local.to_path_buf()
            } else {
                PathBuf::from(dir)
            };
            return Ok((
                job_dir,
                entry.correlation_id,
                entry.ams_state,
                entry.ams_source,
            ));
        }
    }
    Ok((
        local.to_path_buf(),
        String::new(),
        String::new(),
        String::new(),
    ))
}

async fn resolve_conflict_ams(
    config: &crate::storage::config::AppConfig,
    correlation_id: &str,
    job_dir: &std::path::Path,
    cached_state: &str,
    cached_source: &str,
) -> (String, String) {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return (String::new(), String::new());
    }
    if crate::bridge::bridge_configured(config) {
        if let Ok(base) = crate::bridge::resolve_bridge_base_url(config) {
            let identity = crate::bridge::build_ats_bridge_identity(config);
            match crate::bridge::fetch_job_status(&base, &config.ams_bridge_token, cid, &identity)
                .await
            {
                Ok(Some(job)) => return (job.state, "bridge".into()),
                Ok(None) => {}
                Err(e) => {
                    logging::warn("smb", format!("AMS-Status für Konflikt: {e}"));
                }
            }
        }
    }
    let roots = crate::video::handoff_manifest::handoff_share_roots(job_dir, &config.speicherort);
    match crate::video::handoff_manifest::read_status_outbox_any(&roots, cid) {
        Ok(Some(job)) => return (job.state, "outbox".into()),
        Ok(None) => {}
        Err(e) => logging::warn("smb", format!("AMS-Outbox für Konflikt: {e}")),
    }
    (cached_state.to_string(), cached_source.to_string())
}

fn read_manifest_paths(job_dir: &std::path::Path) -> Vec<String> {
    let path = job_dir.join(crate::video::handoff_manifest::MANIFEST_FILENAME);
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<crate::video::handoff_manifest::HandoffManifestV1>(&raw) {
        Ok(doc) => doc.integrity.files.into_iter().map(|f| f.path).collect(),
        Err(_) => Vec::new(),
    }
}
