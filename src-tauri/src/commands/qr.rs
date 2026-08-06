//! Tauri commands for QR scanning (video / photo).

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::model::Kunde;
use crate::qr::analyser::{
    scan_photo, scan_video_clip, QrScanOptions, QrScanResult as CoreResult,
};
use crate::qr::parallel::{
    scan_photos_hybrid_with_progress, scan_videos_hybrid_with_progress,
};
use crate::storage::config::AppConfig;
use crate::video::ffmpeg::{find_ffmpeg_with_resource_dir, reset_cancel_flag};

use super::config::ConfigState;

#[derive(Debug, Clone, Serialize)]
pub struct QrScanResultDto {
    pub found: bool,
    pub kunde: Option<Kunde>,
    pub source_path: Option<String>,
    pub cancelled: bool,
    pub message: String,
}

/// Per-file QR scan progress for the media grid UI.
#[derive(Debug, Clone, Serialize)]
pub struct QrScanProgressEvent {
    pub path: String,
    /// `start` | `done` | `hit`
    pub phase: String,
}

impl From<CoreResult> for QrScanResultDto {
    fn from(r: CoreResult) -> Self {
        Self {
            found: r.found,
            kunde: r.kunde,
            source_path: r.source_path,
            cancelled: r.cancelled,
            message: r.message,
        }
    }
}

fn resolve_ffmpeg(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().ok();
    find_ffmpeg_with_resource_dir(resource_dir.as_deref()).map_err(|e| e.to_string())
}

fn options_from_config(cfg: &AppConfig) -> QrScanOptions {
    let mut opts = QrScanOptions::default();
    if cfg.qr_video_scan_seconds > 0 {
        opts.scan_seconds = f64::from(cfg.qr_video_scan_seconds);
    }
    opts
}

fn read_config(state: &ConfigState) -> AppConfig {
    state
        .cache
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

fn make_progress_cb(app: AppHandle) -> Arc<dyn Fn(&str, &str) + Send + Sync> {
    Arc::new(move |path: &str, phase: &str| {
        let _ = app.emit(
            "qr-scan-progress",
            QrScanProgressEvent {
                path: path.to_string(),
                phase: phase.to_string(),
            },
        );
    })
}

/// Scan a single video file for a customer QR code (first N seconds).
#[tauri::command]
pub async fn scan_qr_video(
    app: AppHandle,
    config: tauri::State<'_, ConfigState>,
    path: String,
) -> Result<QrScanResultDto, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let opts = options_from_config(&read_config(&config));
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        on_progress(&path, "start");
        let res = scan_video_clip(&ffmpeg, &path, &opts, None).map_err(|e| e.to_string())?;
        on_progress(&path, if res.found { "hit" } else { "done" });
        Ok::<_, String>(res)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result.into())
}

/// Scan a single photo file for a customer QR code.
#[tauri::command]
pub async fn scan_qr_photo(
    app: AppHandle,
    config: tauri::State<'_, ConfigState>,
    path: String,
) -> Result<QrScanResultDto, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let opts = options_from_config(&read_config(&config));
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        on_progress(&path, "start");
        let res = scan_photo(&ffmpeg, &path, &opts, None).map_err(|e| e.to_string())?;
        on_progress(&path, if res.found { "hit" } else { "done" });
        Ok::<_, String>(res)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result.into())
}

/// Parallel quarter-based scan over multiple video clips (up to 4 workers).
#[tauri::command]
pub async fn scan_qr_videos(
    app: AppHandle,
    config: tauri::State<'_, ConfigState>,
    paths: Vec<String>,
) -> Result<QrScanResultDto, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("at least one video path is required".into());
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let cfg = read_config(&config);
    let opts = options_from_config(&cfg);
    let workers = if cfg.parallel_processing_enabled { 4 } else { 1 };
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cb = |path: &str, phase: &str| on_progress(path, phase);
        scan_videos_hybrid_with_progress(&ffmpeg, &paths, &opts, workers, None, Some(&cb))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result.into())
}

/// Parallel quarter-based scan over multiple photos (up to 4 workers).
#[tauri::command]
pub async fn scan_qr_photos(
    app: AppHandle,
    config: tauri::State<'_, ConfigState>,
    paths: Vec<String>,
) -> Result<QrScanResultDto, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("at least one photo path is required".into());
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let cfg = read_config(&config);
    let opts = options_from_config(&cfg);
    let workers = if cfg.parallel_processing_enabled { 4 } else { 1 };
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cb = |path: &str, phase: &str| on_progress(path, phase);
        scan_photos_hybrid_with_progress(&ffmpeg, &paths, &opts, workers, None, Some(&cb))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result.into())
}
