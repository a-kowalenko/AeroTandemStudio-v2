//! Tauri commands for video encoding, concat, trim, cut, split, import, create_video, preview.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::config::ConfigState;
use crate::util::natural_sort::sort_paths_by_basename;
use crate::video::concat;
use crate::video::cutter::{self, CutResult, SplitResult};
use crate::video::ffmpeg::{
    cancel_encode as ffmpeg_cancel, find_ffmpeg_with_resource_dir, probe_duration_secs,
    reset_cancel_flag, run_ffmpeg,
};
use crate::video::hw_accel::{build_encode_command, detect_hardware, HwAccelInfo, HwType};
use crate::video::preview_encode::{self, PreviewResult};
use crate::video::probe::{self, VideoMetadata};
use crate::model::Kunde;
use crate::video::export_job::{self, CreateJobOptions, CreateJobResult};
use crate::video::processor::{self, CreateVideoOptions, CreateVideoResult};
use crate::video::progress::EncodeProgress;
use crate::model::ValidationResult;

#[derive(Debug, Serialize)]
pub struct EncodeResult {
    pub output: String,
    pub encoder: String,
    pub hw_type: String,
}

#[derive(Debug, Serialize)]
pub struct ConcatResult {
    pub output: String,
    pub method: String,
    pub codec: String,
    pub reencode_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TrimResult {
    pub output: String,
    pub method: String,
    pub reencode_reason: Option<String>,
}

fn hw_type_label(hw: &HwAccelInfo) -> String {
    match hw.hw_type {
        HwType::Nvidia => "nvidia".into(),
        HwType::Videotoolbox => "videotoolbox".into(),
        HwType::Software => "software".into(),
    }
}

fn resolve_ffmpeg(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().ok();
    find_ffmpeg_with_resource_dir(resource_dir.as_deref()).map_err(|e| e.to_string())
}

/// Detect which hardware encoder will be used.
#[tauri::command]
pub fn get_hw_info() -> Result<HwAccelInfo, String> {
    Ok(detect_hardware())
}

/// Transcode `input` → `output` at 1080p@30fps. Emits `encode-progress` events.
#[tauri::command]
pub async fn encode_video(
    app: AppHandle,
    input: String,
    output: String,
) -> Result<EncodeResult, String> {
    if input.trim().is_empty() || output.trim().is_empty() {
        return Err("input and output paths are required".into());
    }
    if !std::path::Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let (hw, args) = build_encode_command(&input, &output);
    let encoder = hw.encoder.clone();
    let hw_label = hw_type_label(&hw);

    let total_secs = probe_duration_secs(&ffmpeg, &input).unwrap_or(0.0);

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let output_clone = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg(&ffmpeg, &args, total_secs, on_progress).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(EncodeResult {
        output: output_clone,
        encoder,
        hw_type: hw_label,
    })
}

/// Concatenate multiple videos into one MP4 (stream-copy when possible).
#[tauri::command]
pub async fn concat_videos(
    app: AppHandle,
    paths: Vec<String>,
    output: String,
) -> Result<ConcatResult, String> {
    if paths.len() < 2 {
        return Err("at least two input paths are required".into());
    }
    if output.trim().is_empty() {
        return Err("output path is required".into());
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let output_clone = output.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        concat::concat_videos(&ffmpeg, &paths, &output, on_progress).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(ConcatResult {
        output: output_clone,
        method: outcome.method,
        codec: outcome.codec,
        reencode_reason: outcome.reencode_reason,
    })
}

/// Trim video to `[start, end)` seconds. Stream-copy by default; `precise` re-encodes.
#[tauri::command]
pub async fn trim_video(
    app: AppHandle,
    input: String,
    start: f64,
    end: f64,
    output: String,
    precise: Option<bool>,
) -> Result<TrimResult, String> {
    if input.trim().is_empty() || output.trim().is_empty() {
        return Err("input and output paths are required".into());
    }
    if !std::path::Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }

    let precise = precise.unwrap_or(false);
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let output_clone = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        concat::trim_video(&ffmpeg, &input, start, end, &output, precise, on_progress)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(TrimResult {
        output: output_clone,
        method: if precise {
            "re-encode".into()
        } else {
            "stream-copy".into()
        },
        reencode_reason: if precise {
            Some(
                "Präziser Zuschnitt (frame-genau) erfordert Neu-Kodierung".into(),
            )
        } else {
            None
        },
    })
}

/// Cut `[start, end)` — optionally overwrite the source (legacy Schneide-Dialog).
/// Emits `encode-progress`. Use `precise` for frame-accurate re-encode.
#[tauri::command]
pub async fn cut_video(
    app: AppHandle,
    input: String,
    start: f64,
    end: f64,
    output: Option<String>,
    overwrite: Option<bool>,
    precise: Option<bool>,
) -> Result<CutResult, String> {
    if input.trim().is_empty() {
        return Err("input path is required".into());
    }
    if !std::path::Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }

    let overwrite = overwrite.unwrap_or(false);
    let precise = precise.unwrap_or(false);
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    tauri::async_runtime::spawn_blocking(move || {
        cutter::cut_video(
            &ffmpeg,
            &input,
            start,
            end,
            output.as_deref(),
            overwrite,
            precise,
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Split video at `split_secs` into two parts. With `overwrite`, writes `name_1` / `name_2`.
/// Emits `encode-progress`.
#[tauri::command]
pub async fn split_video(
    app: AppHandle,
    input: String,
    split_secs: f64,
    part1_path: Option<String>,
    part2_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<SplitResult, String> {
    if input.trim().is_empty() {
        return Err("input path is required".into());
    }
    if !std::path::Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }

    let overwrite = overwrite.unwrap_or(false);
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    tauri::async_runtime::spawn_blocking(move || {
        cutter::split_video(
            &ffmpeg,
            &input,
            split_secs,
            part1_path.as_deref(),
            part2_path.as_deref(),
            overwrite,
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cancel all currently running FFmpeg processes.
#[tauri::command]
pub fn cancel_encode() -> Result<bool, String> {
    Ok(ffmpeg_cancel())
}

/// Probe a single video for duration, resolution, and codec.
#[tauri::command]
pub async fn probe_video(app: AppHandle, path: String) -> Result<VideoMetadata, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    let ffmpeg = resolve_ffmpeg(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        probe::probe_video(&ffmpeg, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create final MP4: optional intro (background + customer text) + body clips.
#[tauri::command]
pub async fn create_video(
    app: AppHandle,
    kunde: Kunde,
    video_paths: Vec<String>,
    output: String,
    options: Option<CreateVideoOptions>,
) -> Result<CreateVideoResult, String> {
    if video_paths.is_empty() {
        return Err("at least one video path is required".into());
    }
    if output.trim().is_empty() {
        return Err("output path is required".into());
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let resource_dir = app.path().resource_dir().ok();
    let opts = options.unwrap_or_default();

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    tauri::async_runtime::spawn_blocking(move || {
        processor::create_video(
            &ffmpeg,
            &kunde,
            &video_paths,
            &output,
            &opts,
            resource_dir.as_deref(),
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Generate a combined preview MP4 in a temp work dir (CRF from config).
/// Emits `encode-progress` events. Uses intro when `intro_enabled` in config.
/// Requires the same form validation as create (`validate_kunde`).
#[tauri::command]
pub async fn generate_preview(
    app: AppHandle,
    state: State<'_, ConfigState>,
    video_paths: Vec<String>,
    kunde: Kunde,
) -> Result<PreviewResult, String> {
    if video_paths.is_empty() {
        return Err("at least one video path is required".into());
    }

    let config = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.clone()
    };

    let form = crate::model::validate_kunde(&kunde, &video_paths, config.oldschool_mode);
    if !form.valid {
        return Err(form.errors.join("\n"));
    }

    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let resource_dir = app.path().resource_dir().ok();

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    tauri::async_runtime::spawn_blocking(move || {
        preview_encode::generate_preview(
            &ffmpeg,
            &video_paths,
            &kunde,
            &config,
            resource_dir.as_deref(),
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Filter video paths, natural-sort by basename, and probe metadata for each.
#[tauri::command]
pub async fn import_videos(app: AppHandle, paths: Vec<String>) -> Result<Vec<VideoMetadata>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let video_paths: Vec<String> = paths
        .into_iter()
        .filter(|p| probe::is_video_path(p))
        .collect();
    let sorted = sort_paths_by_basename(&video_paths);
    if sorted.is_empty() {
        return Ok(Vec::new());
    }

    let ffmpeg = resolve_ffmpeg(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Copy into session working folder first (Legacy: never mutate originals).
        let working = crate::storage::working_session::import_videos_to_session(&sorted)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(working.len());
        let mut errors = Vec::new();
        for path in &working {
            match probe::probe_video(&ffmpeg, path) {
                Ok(meta) => out.push(meta),
                Err(e) => errors.push(format!("{path}: {e}")),
            }
        }
        if out.is_empty() && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Validate products + media for the unified create/export job.
#[tauri::command]
pub fn validate_create_job(
    state: State<'_, ConfigState>,
    kunde: Kunde,
    video_paths: Option<Vec<String>>,
    photo_paths: Option<Vec<String>>,
    watermark_photo_indices: Option<Vec<usize>>,
    oldschool_mode: Option<bool>,
) -> Result<ValidationResult, String> {
    let oldschool = if let Some(v) = oldschool_mode {
        v
    } else {
        state
            .cache
            .lock()
            .map_err(|e| e.to_string())?
            .oldschool_mode
    };
    let errors = export_job::validate_create_job(
        &kunde,
        &video_paths.unwrap_or_default(),
        &photo_paths.unwrap_or_default(),
        &watermark_photo_indices.unwrap_or_default(),
        oldschool,
    );
    Ok(ValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

/// Full export job: folders, video, photos, watermarks, `_fertig.txt`.
#[tauri::command]
pub async fn create_job(
    app: AppHandle,
    state: State<'_, ConfigState>,
    kunde: Kunde,
    video_paths: Vec<String>,
    photo_paths: Vec<String>,
    options: Option<CreateJobOptions>,
) -> Result<CreateJobResult, String> {
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let resource_dir = app.path().resource_dir().ok();
    let config = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.clone()
    };
    let opts = options.unwrap_or_default();

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    tauri::async_runtime::spawn_blocking(move || {
        export_job::create_job(
            &ffmpeg,
            &kunde,
            &video_paths,
            &photo_paths,
            &config,
            &opts,
            resource_dir.as_deref(),
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
