//! Tauri commands for SD-card monitoring, backup, and import.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config::ConfigState;
use crate::media::thumbnail::{generate_thumbnail_cached_with_ffmpeg, ThumbQuality};
use crate::video::ffmpeg::find_ffmpeg_with_resource_dir;
use crate::sd_card::autoplay;
use crate::sd_card::eject::eject_drive;
use crate::sd_card::monitor::{
    find_dcim_drives, BackupProgress, BackupResult, ImportSdResult, ListSdFilesResult, SdDriveInfo,
    SdFileEnrichment, SdInsertedPayload, WorkflowProgress, EVENT_BACKUP_PROGRESS,
    EVENT_BACKUP_STATUS, EVENT_SD_INSERTED, EVENT_SD_REMOVED, EVENT_WORKFLOW_PROGRESS, SD_MONITOR,
};
use crate::sd_card::secondary_backup::{SecondaryBackupEvent, EVENT_SECONDARY_BACKUP, SECONDARY_BACKUP};
use crate::storage::logging;
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
    let handle5 = app.clone();
    let handle6 = app.clone();

    SD_MONITOR.set_callbacks(
        Some(Arc::new(move |progress: BackupProgress| {
            let _ = handle.emit(EVENT_BACKUP_PROGRESS, progress);
        })),
        Some(Arc::new(move |progress: WorkflowProgress| {
            let _ = handle5.emit(EVENT_WORKFLOW_PROGRESS, progress);
        })),
        Some(Arc::new(move |kind: &str, data: serde_json::Value| {
            let _ = handle2.emit(
                EVENT_BACKUP_STATUS,
                serde_json::json!({ "kind": kind, "data": data }),
            );
        })),
        Some(Arc::new(move |payload: SdInsertedPayload| {
            logging::info(
                "sd",
                format!(
                    "SD erkannt: {} (confirm={})",
                    payload.drive, payload.needs_confirmation
                ),
            );
            if payload.hotplug {
                autoplay::on_sd_inserted(&handle3, &payload.drive);
            }
            let _ = handle3.emit(EVENT_SD_INSERTED, payload);
        })),
        Some(Arc::new(move |drives: Vec<String>| {
            logging::info("sd", format!("SD entfernt: {}", drives.join(", ")));
            let _ = handle4.emit(EVENT_SD_REMOVED, serde_json::json!({ "drives": drives }));
        })),
    );

    SECONDARY_BACKUP.set_callback(Some(Arc::new(move |event: SecondaryBackupEvent| {
        let _ = handle6.emit(EVENT_SECONDARY_BACKUP, event);
    })));
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
    autoplay::install(app);

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
        logging::info("sd", "SD-Monitor gestartet");
    }
    Ok(SD_MONITOR.is_monitoring())
}

#[tauri::command]
pub fn stop_sd_monitor() -> Result<(), String> {
    SD_MONITOR.stop_monitoring();
    logging::info("sd", "SD-Monitor gestoppt");
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
    let drives = find_dcim_drives();
    logging::info("sd", format!("SD-Scan: {} Laufwerk(e)", drives.len()));
    Ok(drives)
}

#[tauri::command]
pub async fn list_sd_files(drive: String) -> Result<ListSdFilesResult, String> {
    logging::info("sd", format!("Liste SD-Dateien: {drive}"));
    let drive_log = drive.clone();
    let result = tauri::async_runtime::spawn_blocking(move || SD_MONITOR.list_files(&drive))
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(res) => {
            logging::info(
                "sd",
                format!(
                    "SD-Dateien: {} Datei(en), {:.1} MB",
                    res.files.len(),
                    res.total_size_mb
                ),
            );
            Ok(res)
        }
        Err(e) => {
            let msg = e.to_string();
            logging::error(
                "sd",
                format!("SD-Liste fehlgeschlagen ({drive_log}): {msg}"),
            );
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn enrich_sd_files(
    drive: String,
    paths: Option<Vec<String>>,
) -> Result<Vec<SdFileEnrichment>, String> {
    let count = paths.as_ref().map(|v| v.len()).unwrap_or(0);
    logging::debug(
        "sd",
        format!("SD-Enrich start: drive={drive}, paths={count}"),
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        SD_MONITOR.enrich_files(&drive, paths)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::debug("sd", format!("SD-Enrich fertig: {} Datei(en)", res.len()));
            Ok(res)
        }
        Err(e) => {
            let msg = e.to_string();
            logging::warn("sd", format!("SD-Enrich fehlgeschlagen: {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn backup_sd_card(
    drive: String,
    selected_files: Option<Vec<String>>,
    clear_after: Option<bool>,
) -> Result<BackupResult, String> {
    let count = selected_files.as_ref().map(|v| v.len());
    logging::info(
        "sd",
        format!(
            "Backup start: drive={drive}, selected={}, clear_after={clear_after:?}",
            count
                .map(|n| n.to_string())
                .unwrap_or_else(|| "all".into())
        ),
    );
    crate::video::ffmpeg::reset_cancel_flag();
    let result = tauri::async_runtime::spawn_blocking(move || {
        SD_MONITOR.backup_drive_with_options(&drive, selected_files, clear_after)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "sd",
                format!(
                    "Backup fertig: copied={}, skipped={}, path={}, secondary={}",
                    res.copied_count,
                    res.skipped_count,
                    res.backup_path.as_deref().unwrap_or("-"),
                    res.secondary_backup_path.as_deref().unwrap_or("-")
                ),
            );
            if let Some(ref w) = res.secondary_warning {
                logging::warn("sd", format!("Zweiter Backup-Pfad: {w}"));
            }
            Ok(res)
        }
        Err(e) => {
            let msg = e.to_string();
            logging::error("sd", format!("Backup fehlgeschlagen: {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn clear_sd_files(paths: Vec<String>) -> Result<usize, String> {
    logging::info(
        "sd",
        format!("SD bereinigen: {} Datei(en)", paths.len()),
    );
    match SD_MONITOR.clear_media_files(&paths) {
        Ok(n) => {
            logging::info("sd", format!("SD bereinigt: {n} Datei(en)"));
            Ok(n)
        }
        Err(e) => {
            let msg = e.to_string();
            logging::error("sd", format!("SD bereinigen fehlgeschlagen: {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn import_sd_files(paths: Vec<String>) -> Result<ImportSdResult, String> {
    logging::info(
        "sd",
        format!("SD-Import start: {} Datei(en)", paths.len()),
    );
    let result = tauri::async_runtime::spawn_blocking(move || SD_MONITOR.import_files(&paths))
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "sd",
                format!(
                    "SD-Import fertig: videos={}, photos={}, skipped={}",
                    res.imported_videos.len(),
                    res.imported_photos.len(),
                    res.skipped
                ),
            );
            Ok(res)
        }
        Err(e) => {
            let msg = e.to_string();
            logging::error("sd", format!("SD-Import fehlgeschlagen: {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn decline_sd_backup(drive: String) -> Result<(), String> {
    logging::info("sd", format!("Backup abgelehnt: {drive}"));
    SD_MONITOR.decline_drive(&drive);
    Ok(())
}

#[tauri::command]
pub fn eject_sd_card(drive: String) -> Result<(), String> {
    logging::info("sd", format!("SD auswerfen: {drive}"));
    match eject_drive(&drive) {
        Ok(()) => {
            logging::info("sd", format!("SD ausgeworfen: {drive}"));
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            logging::error("sd", format!("SD auswerfen fehlgeschlagen ({drive}): {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn get_media_thumbnail(
    app: AppHandle,
    path: String,
    quality: Option<String>,
) -> Result<ThumbnailResult, String> {
    let q = ThumbQuality::parse(quality.as_deref().unwrap_or("lq"));
    let resource_dir = app.path().resource_dir().ok();
    let ffmpeg = find_ffmpeg_with_resource_dir(resource_dir.as_deref()).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let result = generate_thumbnail_cached_with_ffmpeg(
            std::path::Path::new(&path),
            q,
            ffmpeg.as_deref(),
        );
        match result {
            Ok((_bytes, data_url)) => Ok(ThumbnailResult { path, data_url }),
            Err(e) => {
                let msg = e.to_string();
                logging::warn("thumb", format!("Thumbnail fehlgeschlagen ({path}): {msg}"));
                Err(msg)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_processed_files(
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<ProcessedFileEntry>, String> {
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    let entries = hist
        .list_entries(limit.unwrap_or(1000) as usize, search.as_deref())
        .map_err(|e| e.to_string())?;
    logging::debug(
        "history",
        format!(
            "Verlauf geladen: {} Einträge{}",
            entries.len(),
            search
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" (Suche: {s})"))
                .unwrap_or_default()
        ),
    );
    Ok(entries)
}

#[tauri::command]
pub fn delete_processed_files(ids: Vec<i64>) -> Result<(), String> {
    logging::info(
        "history",
        format!("Verlauf: lösche {} Eintrag/Einträge", ids.len()),
    );
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    hist.delete_by_ids(&ids).map_err(|e| {
        let msg = e.to_string();
        logging::error("history", format!("Verlauf löschen fehlgeschlagen: {msg}"));
        msg
    })?;
    logging::info("history", "Verlauf-Einträge gelöscht");
    Ok(())
}

#[tauri::command]
pub fn purge_processed_files() -> Result<(), String> {
    logging::warn("history", "Verlauf wird vollständig geleert");
    let hist = SD_MONITOR.history().map_err(|e| e.to_string())?;
    hist.purge_all().map_err(|e| {
        let msg = e.to_string();
        logging::error("history", format!("Verlauf leeren fehlgeschlagen: {msg}"));
        msg
    })?;
    logging::info("history", "Verlauf geleert");
    Ok(())
}
