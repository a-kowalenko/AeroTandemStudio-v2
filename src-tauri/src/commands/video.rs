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
    cancel_encode as ffmpeg_cancel, find_ffmpeg_with_resource_dir, is_cancelled,
    probe_duration_secs, reset_cancel_flag, run_ffmpeg, WORKFLOW_CANCELLED,
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

/// Rotate video by 90° steps (pixel transpose + re-encode). Emits `encode-progress`.
#[tauri::command]
pub async fn rotate_video(
    app: AppHandle,
    input: String,
    degrees: i32,
    output: Option<String>,
    overwrite: Option<bool>,
) -> Result<CutResult, String> {
    if input.trim().is_empty() {
        return Err("input path is required".into());
    }
    if !std::path::Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }

    let overwrite = overwrite.unwrap_or(false);
    logging::info(
        "edit",
        format!(
            "Rotate start: {} by {degrees}° overwrite={overwrite}",
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
        crate::video::rotate::rotate_video(
            &ffmpeg,
            &input,
            degrees,
            output.as_deref(),
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
                "edit",
                format!(
                    "Rotate fertig: {} (method={}, overwrite={})",
                    file_name(&res.output),
                    res.method,
                    res.overwritten
                ),
            );
            Ok(res)
        }
        Err(e) => {
            log_job_failure("edit", "Drehen", &e);
            Err(e)
        }
    }
}

/// Undo the last overwrite trim/split (restores working-copy backup).
#[tauri::command]
pub async fn undo_last_video_cut() -> Result<crate::video::cut_undo::UndoCutResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::video::cut_undo::undo_last_cut().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo the cut for a specific clip path (trim path or either split part).
#[tauri::command]
pub async fn undo_video_cut_for_path(
    path: String,
) -> Result<crate::video::cut_undo::UndoCutResult, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::video::cut_undo::undo_cut_for_path(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo every recorded cut/split.
#[tauri::command]
pub async fn undo_all_video_cuts() -> Result<Vec<crate::video::cut_undo::UndoCutResult>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::video::cut_undo::undo_all_cuts().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether any cut undo is available.
#[tauri::command]
pub fn has_video_cut_undo() -> bool {
    crate::video::cut_undo::has_cut_undo()
}

/// Paths currently marked as cut (for UI chips).
#[tauri::command]
pub fn list_video_cut_marks() -> Vec<String> {
    crate::video::cut_undo::cut_mark_paths()
}

/// Discard all cut-undo backups without restoring.
#[tauri::command]
pub fn clear_video_cut_undo() {
    crate::video::cut_undo::clear_cut_undo();
}

/// Drop undo backup for one path without restoring (clip removed from list).
#[tauri::command]
pub fn discard_video_cut_undo_for_path(path: String) {
    if path.trim().is_empty() {
        return;
    }
    crate::video::cut_undo::discard_cut_undo_for_path(&path);
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

/// Cancel currently running FFmpeg work (encode, QR frame extract, etc.).
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

/// List keyframe timestamps (seconds) for stream-copy-friendly trim snapping.
#[tauri::command]
pub async fn list_video_keyframes(
    app: AppHandle,
    path: String,
    duration_secs: Option<f64>,
) -> Result<Vec<f64>, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("input file not found: {path}"));
    }
    let ffmpeg = resolve_ffmpeg(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::video::keyframe_cache::list_keyframes_cached(&ffmpeg, &path, duration_secs)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Evenly spaced JPEG filmstrip frames (HTTP media URLs) for the Apple-style trim timeline.
#[tauri::command]
pub async fn get_video_filmstrip(
    app: AppHandle,
    path: String,
    count: Option<u32>,
    height: Option<u32>,
    duration_secs: Option<f64>,
    media: State<'_, crate::media::http_server::MediaServerState>,
) -> Result<Vec<String>, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("input file not found: {path}"));
    }
    let ffmpeg = resolve_ffmpeg(&app)?;
    let frame_count =
        count.unwrap_or(crate::media::filmstrip::DEFAULT_FRAME_COUNT as u32) as usize;
    let frame_height = height.unwrap_or(crate::media::filmstrip::DEFAULT_FRAME_HEIGHT);
    let media_base = media.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = crate::media::filmstrip::generate_filmstrip(
            std::path::Path::new(&path),
            frame_count,
            frame_height,
            duration_secs,
            Some(&ffmpeg),
        )
        .map_err(|e| e.to_string())?;
        Ok(paths
            .into_iter()
            .map(|p| media_base.url_for_path(&p.to_string_lossy()))
            .collect::<Vec<_>>())
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
    reset_cancel_flag();
    let ffmpeg = resolve_ffmpeg(&app)?;
    let app_progress = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        use crate::sd_card::monitor::{
            workflow_progress_import_copy, workflow_progress_import_probe, EVENT_WORKFLOW_PROGRESS,
        };
        use std::time::{Duration, Instant, SystemTime};
        use tauri::Emitter;

        let n = sorted.len() as u64;
        let total_bytes: u64 = sorted
            .iter()
            .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
            .sum();
        let mut copied_bytes: u64 = 0;
        let start = SystemTime::now();
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        let emit_copy = |copied_bytes: u64,
                         file_index: u64,
                         file_name: &str,
                         force: bool,
                         last: &mut Instant| {
            if !force && last.elapsed() < Duration::from_millis(150) {
                return;
            }
            let elapsed = start.elapsed().unwrap_or_default().as_secs_f64();
            let current_mb = copied_bytes as f64 / (1024.0 * 1024.0);
            let speed = if elapsed > 0.0 {
                current_mb / elapsed
            } else {
                0.0
            };
            let _ = app_progress.emit(
                EVENT_WORKFLOW_PROGRESS,
                workflow_progress_import_copy(
                    copied_bytes,
                    total_bytes,
                    speed,
                    file_index,
                    n,
                    file_name,
                    "Kopiere Videos…",
                ),
            );
            *last = Instant::now();
        };

        emit_copy(0, 0, "", true, &mut last_emit);
        let mut working = Vec::with_capacity(sorted.len());
        for (i, path) in sorted.iter().enumerate() {
            if is_cancelled() {
                crate::storage::working_session::rollback_working_import_paths(&working);
                return Err(WORKFLOW_CANCELLED.into());
            }
            let file_index = (i as u64) + 1;
            let name = file_name(path);
            emit_copy(copied_bytes, file_index, &name, true, &mut last_emit);
            let dest = match crate::storage::working_session::import_video_to_session_with_progress(
                path,
                |delta| {
                    copied_bytes += delta;
                    emit_copy(copied_bytes, file_index, &name, false, &mut last_emit);
                },
            ) {
                Ok(dest) => dest.to_string_lossy().into_owned(),
                Err(e) => {
                    crate::storage::working_session::rollback_working_import_paths(&working);
                    return Err(e.to_string());
                }
            };
            working.push(dest);
            emit_copy(copied_bytes, file_index, &name, true, &mut last_emit);
        }
        logging::info(
            "import",
            format!("Videos kopiert: {} Datei(en), starte Probe…", working.len()),
        );
        let mut out = Vec::with_capacity(working.len());
        let mut errors = Vec::new();
        for (i, path) in working.iter().enumerate() {
            if is_cancelled() {
                crate::storage::working_session::rollback_working_import_paths(&working);
                return Err(WORKFLOW_CANCELLED.into());
            }
            let file_index = (i as u64) + 1;
            let name = file_name(path);
            let _ = app_progress.emit(
                EVENT_WORKFLOW_PROGRESS,
                workflow_progress_import_probe(file_index, n, &name, "Analysiere Videos…"),
            );
            match probe::probe_video(&ffmpeg, path) {
                Ok(meta) => {
                    let device = probe::format_camera_label(&meta.camera_make, &meta.camera_model)
                        .map(|l| format!(", Gerät: {l}"))
                        .unwrap_or_default();
                    logging::debug(
                        "import",
                        format!(
                            "Probe OK: {} ({}x{}, {:.1}s, {}{})",
                            name,
                            meta.width,
                            meta.height,
                            meta.duration_secs,
                            meta.codec,
                            device
                        ),
                    );
                    out.push(meta);
                }
                Err(e) => {
                    logging::warn(
                        "import",
                        format!("Probe fehlgeschlagen ({name}): {e}"),
                    );
                    errors.push(format!("{path}: {e}"));
                }
            }
            let _ = app_progress.emit(
                EVENT_WORKFLOW_PROGRESS,
                workflow_progress_import_probe(file_index, n, &name, "Analysiere Videos…"),
            );
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
            let with_device = out
                .iter()
                .filter(|m| {
                    probe::format_camera_label(&m.camera_make, &m.camera_model).is_some()
                })
                .count();
            logging::info(
                "import",
                format!(
                    "Video-Import fertig: {} Clip(s), {} mit Geräte-Tag",
                    out.len(),
                    with_device
                ),
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
    qr_preview: Option<crate::qr::analyser::QrPreview>,
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

    let kunde_for_history = kunde.clone();
    let videos_for_history = video_paths.clone();
    let photos_for_history = photo_paths.clone();
    let manual_entry_mode_for_history = config.manual_entry_mode.clone();
    let qr_preview_for_history = qr_preview.filter(|p| !p.path.trim().is_empty());

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
            if let Err(e) = crate::storage::vorgang_history::VorgangHistoryStore::open_default()
                .and_then(|store| {
                    store.record_create_job(
                        &kunde_for_history,
                        &videos_for_history,
                        &photos_for_history,
                        &res,
                        &manual_entry_mode_for_history,
                        qr_preview_for_history.as_ref(),
                    )
                })
            {
                logging::error(
                    "vorgang_history",
                    format!("Vorgang-Historie konnte nicht gespeichert werden: {e}"),
                );
            }
            Ok(res)
        }
        Err(e) => {
            log_job_failure("create", "Vorgang", &e);
            Err(e)
        }
    }
}
