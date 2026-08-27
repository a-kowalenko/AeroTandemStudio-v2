//! Tauri commands for SMB server connection & upload.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::config::ConfigState;
use crate::smb::{
    abort_handoff_upload, notify_handoff_after_upload, upload_failure_is_cancelled,
    test_connection, upload_path, ConnectionTestResult, HandoffUploadContext, UploadProgress,
    UploadResult,
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
) -> Result<ConnectionTestResult, String> {
    let (url, login, password) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let o = overrides.unwrap_or_default();
        (
            o.server_url.unwrap_or_else(|| cache.server_url.clone()),
            o.server_login
                .unwrap_or_else(|| cache.server_login.clone()),
            o.server_password
                .unwrap_or_else(|| cache.server_password.clone()),
        )
    };
    logging::info(
        "smb",
        format!("Server-Test: url={}", url.trim()),
    );
    let result = test_connection(&url, &login, &password).await;
    if result.ok {
        logging::info("smb", format!("Server-Test OK: {}", result.message));
    } else {
        logging::warn("smb", format!("Server-Test fehlgeschlagen: {}", result.message));
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

    let (config, url, login, password) = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        let o = overrides.unwrap_or_default();
        (
            cache.clone(),
            o.server_url.unwrap_or_else(|| cache.server_url.clone()),
            o.server_login
                .unwrap_or_else(|| cache.server_login.clone()),
            o.server_password
                .unwrap_or_else(|| cache.server_password.clone()),
        )
    };

    logging::info(
        "smb",
        format!("Upload start: {}", file_name(&local_path)),
    );

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
        UploadCancelPolicy::SlotOnly,
        move |progress| {
            let event = UploadProgressEvent::from(progress);
            let _ = app_for_progress.emit(UPLOAD_PROGRESS_EVENT, &event);
        },
    )
    .await;

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
        } else {
            logging::error("smb", format!("Upload fehlgeschlagen: {}", result.message));
        }
        Err(result.message)
    }
}
