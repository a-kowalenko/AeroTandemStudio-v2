//! Tauri commands for SMB server connection & upload.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::config::ConfigState;
use crate::smb::{test_connection, upload_path, ConnectionTestResult, UploadProgress, UploadResult};

pub const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgressEvent {
    pub percent: f64,
    pub current_file: u32,
    pub total_files: u32,
    pub current_bytes: u64,
    pub total_bytes: u64,
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
    Ok(test_connection(&url, &login, &password).await)
}

/// Upload a finished video file or an entire folder to the configured server.
#[tauri::command]
pub async fn upload_to_server(
    app: AppHandle,
    state: State<'_, ConfigState>,
    local_path: String,
    overrides: Option<ServerOverrides>,
) -> Result<UploadResult, String> {
    let path = PathBuf::from(&local_path);
    if !path.exists() {
        return Err(format!("Lokaler Pfad existiert nicht: {local_path}"));
    }

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

    let app_for_progress = app.clone();
    let result = upload_path(&path, &url, &login, &password, |progress| {
        let event = UploadProgressEvent::from(progress);
        let _ = app_for_progress.emit(UPLOAD_PROGRESS_EVENT, &event);
    })
    .await;

    if result.success {
        Ok(result)
    } else {
        Err(result.message)
    }
}
