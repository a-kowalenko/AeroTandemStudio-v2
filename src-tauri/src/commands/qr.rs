//! Tauri commands for QR scanning (video / photo).

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::model::Kunde;
use crate::qr::analyser::{
    discard_qr_preview, scan_photo, scan_video_clip_with_progress, CleanupDirection, QrPreview,
    QrScanOptions, QrScanResult as CoreResult, QrSpotlight,
};
use crate::qr::followup::scan_series_followup_hits;
use crate::qr::parallel::{
    scan_photos_hybrid_with_progress, scan_videos_hybrid_with_progress,
};
use crate::storage::config::AppConfig;
use crate::storage::logging::{self, file_name};
use crate::video::ffmpeg::{find_ffmpeg_with_resource_dir, reset_cancel_flag};

use super::config::ConfigState;

#[derive(Debug, Clone, Serialize)]
pub struct QrSpotlightDto {
    pub x: f32,
    pub y: f32,
    pub size: f32,
}

impl From<QrSpotlight> for QrSpotlightDto {
    fn from(s: QrSpotlight) -> Self {
        Self {
            x: s.x,
            y: s.y,
            size: s.size,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QrPreviewDto {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub spotlight: Option<QrSpotlightDto>,
}

impl From<QrPreview> for QrPreviewDto {
    fn from(p: QrPreview) -> Self {
        Self {
            path: p.path,
            width: p.width,
            height: p.height,
            spotlight: p.spotlight.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QrScanResultDto {
    pub found: bool,
    pub kunde: Option<Kunde>,
    pub source_path: Option<String>,
    pub cancelled: bool,
    pub message: String,
    pub preview: Option<QrPreviewDto>,
    pub cleanup_direction: CleanupDirection,
}

/// Per-file QR scan progress for the media grid UI.
#[derive(Debug, Clone, Serialize)]
pub struct QrScanProgressEvent {
    pub path: String,
    /// `start` | `done` | `hit` | `extract` | `fast` | `thorough`
    pub phase: String,
    /// 1-based attempt when `phase` is `fast`/`thorough`; 0 for `extract` start.
    #[serde(default)]
    pub frame: u32,
    /// Candidate count for the current pass when phase is extract/fast/thorough.
    #[serde(default)]
    pub frames_total: u32,
}

/// Live status while removing neighboring QR carrier photos after a hit.
#[derive(Debug, Clone, Serialize)]
pub struct QrFollowupProgressEvent {
    pub path: String,
    /// `start` | `hit` | `miss`
    pub phase: String,
    /// Follow-up files scanned so far (completed start→result cycles).
    pub scanned: u32,
    /// Additional QR carriers found in follow-up (excludes the original hit).
    pub extra_hits: u32,
}

impl From<CoreResult> for QrScanResultDto {
    fn from(r: CoreResult) -> Self {
        Self {
            found: r.found,
            kunde: r.kunde,
            source_path: r.source_path,
            cancelled: r.cancelled,
            message: r.message,
            preview: r.preview.map(Into::into),
            cleanup_direction: r.cleanup_direction,
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

fn make_progress_cb(app: AppHandle) -> Arc<dyn Fn(&str, &str, u32, u32) + Send + Sync> {
    Arc::new(move |path: &str, phase: &str, frame: u32, frames_total: u32| {
        let _ = app.emit(
            "qr-scan-progress",
            QrScanProgressEvent {
                path: path.to_string(),
                phase: phase.to_string(),
                frame,
                frames_total,
            },
        );
    })
}

fn log_qr_result(kind: &str, path: &str, dto: &QrScanResultDto) {
    if dto.cancelled {
        logging::warn("qr", format!("{kind} abgebrochen: {}", file_name(path)));
        return;
    }
    if dto.found {
        let gast = dto
            .kunde
            .as_ref()
            .map(|k| k.resolve_gast())
            .unwrap_or_default();
        logging::info(
            "qr",
            format!("{kind} Treffer: {} → Gast={gast}", file_name(path)),
        );
    } else {
        logging::info(
            "qr",
            format!("{kind} ohne Treffer: {} ({})", file_name(path), dto.message),
        );
    }
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
    logging::info("qr", format!("Video-Scan start: {}", file_name(&path)));
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let opts = options_from_config(&read_config(&config));
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        on_progress(&path, "start", 0, 0);
        let progress = |p: &str, phase: &str, frame: u32, total: u32| {
            on_progress(p, phase, frame, total);
        };
        let res = scan_video_clip_with_progress(&ffmpeg, &path, &opts, None, Some(&progress))
            .map_err(|e| e.to_string())?;
        on_progress(&path, if res.found { "hit" } else { "done" }, 0, 0);
        Ok::<_, String>((path, res))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (path, res) = result;
    let dto: QrScanResultDto = res.into();
    log_qr_result("Video-Scan", &path, &dto);
    Ok(dto)
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
    logging::info("qr", format!("Foto-Scan start: {}", file_name(&path)));
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let opts = options_from_config(&read_config(&config));
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        on_progress(&path, "start", 0, 0);
        let res = scan_photo(&ffmpeg, &path, &opts, None).map_err(|e| e.to_string())?;
        on_progress(&path, if res.found { "hit" } else { "done" }, 0, 0);
        Ok::<_, String>((path, res))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (path, res) = result;
    let dto: QrScanResultDto = res.into();
    log_qr_result("Foto-Scan", &path, &dto);
    Ok(dto)
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
    logging::info(
        "qr",
        format!(
            "Video-Batch-Scan start: {} Datei(en), workers={workers}, strategy=ends-first, window={:.0}s",
            paths.len(),
            opts.scan_seconds
        ),
    );
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cb = |path: &str, phase: &str, frame: u32, frames_total: u32| {
            if phase == "start" {
                logging::debug("qr", format!("Scan start: {}", file_name(path)));
            } else if phase == "hit" {
                logging::info("qr", format!("Scan Treffer: {}", file_name(path)));
            }
            on_progress(path, phase, frame, frames_total);
        };
        scan_videos_hybrid_with_progress(&ffmpeg, &paths, &opts, workers, None, Some(&cb))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let dto: QrScanResultDto = result.into();
    if dto.found {
        let src = dto.source_path.as_deref().unwrap_or("?");
        let gast = dto
            .kunde
            .as_ref()
            .map(|k| k.resolve_gast())
            .unwrap_or_default();
        logging::info(
            "qr",
            format!("Video-Batch-Scan Treffer in {}: Gast={gast}", file_name(src)),
        );
    } else if dto.cancelled {
        logging::warn("qr", "Video-Batch-Scan abgebrochen");
    } else {
        logging::info("qr", format!("Video-Batch-Scan ohne Treffer: {}", dto.message));
    }
    Ok(dto)
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
    logging::info(
        "qr",
        format!(
            "Foto-Batch-Scan start: {} Datei(en), workers={workers}, strategy=ends-first",
            paths.len()
        ),
    );
    let on_progress = make_progress_cb(app.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cb = |path: &str, phase: &str, frame: u32, frames_total: u32| {
            if phase == "start" {
                logging::debug("qr", format!("Scan start: {}", file_name(path)));
            } else if phase == "hit" {
                logging::info("qr", format!("Scan Treffer: {}", file_name(path)));
            }
            on_progress(path, phase, frame, frames_total);
        };
        scan_photos_hybrid_with_progress(&ffmpeg, &paths, &opts, workers, None, Some(&cb))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let dto: QrScanResultDto = result.into();
    if dto.found {
        let src = dto.source_path.as_deref().unwrap_or("?");
        let gast = dto
            .kunde
            .as_ref()
            .map(|k| k.resolve_gast())
            .unwrap_or_default();
        logging::info(
            "qr",
            format!("Foto-Batch-Scan Treffer in {}: Gast={gast}", file_name(src)),
        );
    } else if dto.cancelled {
        logging::warn("qr", "Foto-Batch-Scan abgebrochen");
    } else {
        logging::info("qr", format!("Foto-Batch-Scan ohne Treffer: {}", dto.message));
    }
    Ok(dto)
}

/// Bidirectional series follow-up: neighbors with customer QR (for cleanup removal).
#[tauri::command]
pub async fn scan_qr_photo_followups(
    app: AppHandle,
    config: tauri::State<'_, ConfigState>,
    ordered_paths: Vec<String>,
    hit_path: String,
) -> Result<Vec<String>, String> {
    let hit_path = hit_path.trim().to_string();
    if hit_path.is_empty() {
        return Err("hit_path is required".into());
    }
    let ordered_paths: Vec<String> = ordered_paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if ordered_paths.is_empty() {
        return Ok(Vec::new());
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let opts = options_from_config(&read_config(&config));
    logging::info(
        "qr",
        format!(
            "Foto-Follow-up start (bidirektional): hit={}, list={}",
            file_name(&hit_path),
            ordered_paths.len()
        ),
    );

    let app_progress = app.clone();
    let hits = tauri::async_runtime::spawn_blocking(move || {
        let cb = |path: &str, phase: &str, scanned: usize, extra_hits: usize| {
            let _ = app_progress.emit(
                "qr-followup-progress",
                QrFollowupProgressEvent {
                    path: path.to_string(),
                    phase: phase.to_string(),
                    scanned: scanned as u32,
                    extra_hits: extra_hits as u32,
                },
            );
        };
        scan_series_followup_hits(&ffmpeg, &ordered_paths, &hit_path, &opts, Some(&cb))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    logging::info(
        "qr",
        format!("Foto-Follow-up: {} weitere QR-Träger", hits.len()),
    );
    Ok(hits)
}

/// Remove a persisted QR hit-frame preview (and its temp directory).
#[tauri::command]
pub fn discard_qr_preview_file(path: String) -> Result<(), String> {
    discard_qr_preview(&path)
}
