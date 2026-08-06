//! Tauri commands for SD-card monitoring, backup, and import.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config::ConfigState;
use crate::media::thumbnail::{generate_thumbnail_jpeg, THUMB_MAX_SIZE};
use crate::sd_card::monitor::{
    find_dcim_drives, BackupProgress, BackupResult, ImportSdResult, ListSdFilesResult, SdDriveInfo,
    SdInsertedPayload, EVENT_BACKUP_PROGRESS, EVENT_BACKUP_STATUS, EVENT_SD_INSERTED,
    EVENT_SD_REMOVED, SD_MONITOR,
};
use crate::storage::media_history::ProcessedFileEntry;

#[derive(Debug, Serialize)]
pub struct ThumbnailResult {
    pub path: String,
    pub data_url: String,
}

#[derive(Debug, Serialize)]
pub struct SdStatusSnapshot {
    pub monitoring: bool,
    pub drives: Vec<SdDriveInfo>,
    pub backup_in_progress: bool,
}

fn wire_monitor_events(app: &AppHandle) {
    let handle = app.clone();
    let handle2 = app.clone();
    let handle3 = app.clone();
    let handle4 = app.clone();

    SD_MONITOR.set_callbacks(
        Some(Arc::new(move |progress: BackupProgress| {
            let _ = handle.emit(EVENT_BACKUP_PROGRESS, progress);
        })),
        Some(Arc::new(move |kind: &str, data: serde_json::Value| {
            let _ = handle2.emit(
                EVENT_BACKUP_STATUS,
                serde_json::json!({ "kind": kind, "data": data }),
            );
        })),
        Some(Arc::new(move |payload: SdInsertedPayload| {
            let _ = handle3.emit(EVENT_SD_INSERTED, payload);
        })),
        Some(Arc::new(move |drives: Vec<String>| {
            let _ = handle4.emit(EVENT_SD_REMOVED, serde_json::json!({ "drives": drives }));
        })),
    );
}

/// Called once at app startup to bind config + events and optionally start polling.
pub fn init_sd_monitor(app: &AppHandle) {
    let app_handle = app.clone();
    SD_MONITOR.set_config_provider(move || {
        if let Some(state) = app_handle.try_state::<ConfigState>() {
            if let Ok(cache) = state.cache.lock() {
                return cache.clone();
            }
        }
        crate::storage::AppConfig::default()
    });
    wire_monitor_events(app);

    let cfg = {
        if let Some(state) = app.try_state::<ConfigState>() {
            state.cache.lock().ok().map(|c| c.clone())
        } else {
            None
        }
    };
    if let Some(cfg) = cfg {
        if cfg.sd_auto_backup {
            SD_MONITOR.start_monitoring();
        }
    }
}

#[tauri::command]
pub fn start_sd_monitor(app: AppHandle) -> Result<bool, String> {
    init_sd_monitor(&app);
    if !SD_MONITOR.is_monitoring() {
        SD_MONITOR.start_monitoring();
    }
    Ok(SD_MONITOR.is_monitoring())
}

#[tauri::command]
pub fn stop_sd_monitor() -> Result<(), String> {
    SD_MONITOR.stop_monitoring();
    Ok(())
}

#[tauri::command]
pub fn get_sd_status() -> Result<SdStatusSnapshot, String> {
    Ok(SdStatusSnapshot {
        monitoring: SD_MONITOR.is_monitoring(),
        drives: find_dcim_drives(),
        backup_in_progress: false,
    })
}

#[tauri::command]
pub fn scan_sd_drives() -> Result<Vec<SdDriveInfo>, String> {
    Ok(find_dcim_drives())
}

#[tauri::command]
pub fn list_sd_files(drive: String) -> Result<ListSdFilesResult, String> {
    SD_MONITOR.list_files(&drive).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backup_sd_card(
    drive: String,
    selected_files: Option<Vec<String>>,
) -> Result<BackupResult, String> {
    SD_MONITOR
        .backup_drive(&drive, selected_files)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_sd_files(paths: Vec<String>) -> Result<ImportSdResult, String> {
    SD_MONITOR.import_files(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn decline_sd_backup(drive: String) -> Result<(), String> {
    SD_MONITOR.decline_drive(&drive);
    Ok(())
}

#[tauri::command]
pub fn get_media_thumbnail(path: String) -> Result<ThumbnailResult, String> {
    let (_bytes, data_url) = generate_thumbnail_jpeg(std::path::Path::new(&path), THUMB_MAX_SIZE)
        .map_err(|e| e.to_string())?;
    Ok(ThumbnailResult { path, data_url })
}

#[tauri::command]
pub fn list_processed_files(
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<ProcessedFileEntry>, String> {
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    hist.list_entries(limit.unwrap_or(1000) as usize, search.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_processed_files(ids: Vec<i64>) -> Result<(), String> {
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    hist.delete_by_ids(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn purge_processed_files() -> Result<(), String> {
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    hist.purge_all().map_err(|e| e.to_string())
}
