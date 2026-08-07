//! Tauri commands for video encoding, concat, trim, cut, split, import, create_video, preview.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::config::ConfigState;
use crate::storage::logging::{self, file_name};
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
use crate::video::intro_mux_fallback::{self, IntroMuxChoice};
use crate::video::processor::{self, CreateVideoOptions, CreateVideoResult, IntroMuxAskFn};
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

fn is_cancel_err(e: &str) -> bool {
    let lower = e.to_lowercase();
    lower.contains("cancel") || lower.contains("abgebrochen") || lower.contains("abbruch")
}

fn log_job_failure(scope: &str, label: &str, e: &str) {
    if is_cancel_err(e) {
        logging::warn(scope, format!("{label} abgebrochen: {e}"));
    } else {
        logging::error(scope, format!("{label} fehlgeschlagen: {e}"));
    }
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

    logging::info(
        "encode",
        format!(
            "Encode start: {} → {}",
            file_name(&input),
            file_name(&output)
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let (hw, args) = build_encode_command(&input, &output);
    let encoder = hw.encoder.clone();
    let hw_label = hw_type_label(&hw);
    logging::info(
        "encode",
        format!("Encoder: {encoder} ({hw_label})"),
    );

    let total_secs = probe_duration_secs(&ffmpeg, &input).unwrap_or(0.0);

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let output_clone = output.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg(&ffmpeg, &args, total_secs, on_progress).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => {
            logging::info(
                "encode",
                format!("Encode fertig: {}", file_name(&output_clone)),
            );
            Ok(EncodeResult {
                output: output_clone,
                encoder,
                hw_type: hw_label,
            })
        }
        Err(e) => {
            log_job_failure("encode", "Encode", &e);
            Err(e)
        }
    }
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

    logging::info(
        "concat",
        format!(
            "Concat start: {} Clips → {}",
            paths.len(),
            file_name(&output)
        ),
    );
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
    .map_err(|e| e.to_string())?;

    match outcome {
        Ok(outcome) => {
            logging::info(
                "concat",
                format!(
                    "Concat fertig: method={}, codec={}{}",
                    outcome.method,
                    outcome.codec,
                    outcome
                        .reencode_reason
                        .as_ref()
                        .map(|r| format!(" ({r})"))
                        .unwrap_or_default()
                ),
            );
            Ok(ConcatResult {
                output: output_clone,
                method: outcome.method,
                codec: outcome.codec,
                reencode_reason: outcome.reencode_reason,
            })
        }
        Err(e) => {
            log_job_failure("concat", "Concat", &e);
            Err(e)
        }
    }
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
    logging::info(
        "trim",
        format!(
            "Trim start: {} [{start:.3}s–{end:.3}s] precise={precise} → {}",
            file_name(&input),
            file_name(&output)
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let output_clone = output.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        concat::trim_video(&ffmpeg, &input, start, end, &output, precise, on_progress)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => {
            let method = if precise {
                "re-encode"
            } else {
                "stream-copy"
            };
            logging::info("trim", format!("Trim fertig ({method}): {}", file_name(&output_clone)));
            Ok(TrimResult {
                output: output_clone,
                method: method.into(),
                reencode_reason: if precise {
                    Some(
                        "Präziser Zuschnitt (frame-genau) erfordert Neu-Kodierung".into(),
                    )
                } else {
                    None
                },
            })
        }
        Err(e) => {
            log_job_failure("trim", "Trim", &e);
            Err(e)
        }
    }
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
    logging::info(
        "cut",
        format!(
            "Cut start: {} [{start:.3}s–{end:.3}s] overwrite={overwrite} precise={precise}",
            file_name(&input)
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "cut",
                format!(
                    "Cut fertig: {} (method={}, overwrite={})",
                    file_name(&res.output),
                    res.method,
                    res.overwritten
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("cut", "Cut", &e);
            Err(e)
        }
    }
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
    logging::info(
        "cut",
        format!(
            "Split start: {} at {split_secs:.3}s overwrite={overwrite}",
            file_name(&input)
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "cut",
                format!(
                    "Split fertig: {} + {} (method={})",
                    file_name(&res.part1_path),
                    file_name(&res.part2_path),
                    res.method
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("cut", "Split", &e);
            Err(e)
        }
    }
}

/// Cancel all currently running FFmpeg processes.
#[tauri::command]
pub fn cancel_encode() -> Result<bool, String> {
    logging::warn("encode", "Abbruch angefordert (cancel_encode)");
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

    logging::info(
        "create",
        format!(
            "create_video start: {} Clip(s) → {} (Gast={})",
            video_paths.len(),
            file_name(&output),
            kunde.resolve_gast()
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let resource_dir = app.path().resource_dir().ok();
    let opts = options.unwrap_or_default();

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let app_for_ask = app.clone();
    let on_intro_mux_fallback: IntroMuxAskFn = Arc::new(move |reason: &str| {
        intro_mux_fallback::wait_for_choice(&app_for_ask, reason)
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
        processor::create_video(
            &ffmpeg,
            &kunde,
            &video_paths,
            &output,
            &opts,
            resource_dir.as_deref(),
            on_progress,
            Some(on_intro_mux_fallback),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "create",
                format!(
                    "create_video fertig: encoder={}, intro={}, body_clips={}",
                    res.encoder, res.intro_created, res.body_clips
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("create", "create_video", &e);
            Err(e)
        }
    }
}

/// Resolve a pending Intro+Body stream-copy fallback decision from the UI.
#[tauri::command]
pub fn resolve_intro_mux_fallback(choice: String) -> Result<(), String> {
    let parsed = IntroMuxChoice::parse(&choice)
        .ok_or_else(|| format!("Ungültige Wahl: {choice}"))?;
    intro_mux_fallback::resolve_choice(parsed)
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
        logging::warn(
            "preview",
            format!("Vorschau abgebrochen (Formular): {}", form.errors.join("; ")),
        );
        return Err(form.errors.join("\n"));
    }

    logging::info(
        "preview",
        format!(
            "Preview start: {} Clip(s), Gast={}",
            video_paths.len(),
            kunde.resolve_gast()
        ),
    );
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let resource_dir = app.path().resource_dir().ok();

    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "preview",
                format!(
                    "Preview fertig: {} (encoder={}, intro={}, strategy={})",
                    file_name(&res.preview_path),
                    res.encoder,
                    res.intro_included,
                    res.strategy
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("preview", "Preview", &e);
            Err(e)
        }
    }
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
        logging::warn("import", "Video-Import: keine gültigen Videopfade");
        return Ok(Vec::new());
    }

    logging::info(
        "import",
        format!("Importiere {} Video(s) (Kopie + Probe)…", sorted.len()),
    );
    let ffmpeg = resolve_ffmpeg(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Copy into session working folder first (Legacy: never mutate originals).
        let working = crate::storage::working_session::import_videos_to_session(&sorted)
            .map_err(|e| e.to_string())?;
        logging::info(
            "import",
            format!("Videos kopiert: {} Datei(en), starte Probe…", working.len()),
        );
        let mut out = Vec::with_capacity(working.len());
        let mut errors = Vec::new();
        for path in &working {
            match probe::probe_video(&ffmpeg, path) {
                Ok(meta) => {
                    logging::debug(
                        "import",
                        format!(
                            "Probe OK: {} ({}x{}, {:.1}s, {})",
                            file_name(path),
                            meta.width,
                            meta.height,
                            meta.duration_secs,
                            meta.codec
                        ),
                    );
                    out.push(meta);
                }
                Err(e) => {
                    logging::warn(
                        "import",
                        format!("Probe fehlgeschlagen ({}): {e}", file_name(path)),
                    );
                    errors.push(format!("{path}: {e}"));
                }
            }
        }
        if out.is_empty() && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(out) => {
            logging::info(
                "import",
                format!("Video-Import fertig: {} Clip(s)", out.len()),
            );
            Ok(out)
        }
        Err(e) => {
            logging::error("import", format!("Video-Import fehlgeschlagen: {e}"));
            Err(e)
        }
    }
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
    logging::info(
        "create",
            format!(
            "Vorgang starten: Gast={}, Videos={}, Fotos={}",
            kunde.resolve_gast(),
            video_paths.len(),
            photo_paths.len(),
        ),
    );
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

    let app_for_ask = app.clone();
    let on_intro_mux_fallback: IntroMuxAskFn = Arc::new(move |reason: &str| {
        intro_mux_fallback::wait_for_choice(&app_for_ask, reason)
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
        export_job::create_job(
            &ffmpeg,
            &kunde,
            &video_paths,
            &photo_paths,
            &config,
            &opts,
            resource_dir.as_deref(),
            on_progress,
            Some(on_intro_mux_fallback),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(res) => {
            logging::info(
                "create",
                format!(
                    "Vorgang fertig: dir={}, video={}, fotos={}, wm_fotos={}, reused_preview={}, encoder={}",
                    res.base_filename,
                    res.video_output.is_some(),
                    res.photos_copied,
                    res.watermark_photos,
                    res.reused_preview,
                    res.encoder
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("create", "Vorgang", &e);
            Err(e)
        }
    }
}
