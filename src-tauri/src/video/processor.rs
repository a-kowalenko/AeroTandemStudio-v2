//! Intro pipeline & final video creation (behaviour port of legacy `processor.py`).
//!
//! Phase 3: Hintergrund-PNG + drawtext overlay → Intro, body concat, mux.
//! Phase 4: Multi-clip body concat prep runs in parallel; progress may include `task_id`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::constants::{
    ASSET_HINTERGRUND, CONTENT_AREA_PADDING_BOTTOM, CONTENT_AREA_PADDING_LEFT,
    CONTENT_AREA_PADDING_RIGHT, CONTENT_AREA_PADDING_TOP, CONTENT_AREA_X1, CONTENT_AREA_X2,
    CONTENT_AREA_Y1, CONTENT_AREA_Y2, DEFAULT_INTRO_DAUER_SECS, HINTERGRUND_ORIGINAL_HEIGHT,
    HINTERGRUND_ORIGINAL_WIDTH,
};
use crate::model::Kunde;
use super::concat::{self, ConcatError, VideoCodec};
use super::encoding_quality::{
    build_encode_output_params, resolve_output_codec, VideoCodecPreference,
};
use super::ffmpeg::{
    ffmpeg_probe_stderr, is_cancelled, probe_duration_secs, run_ffmpeg, run_ffmpeg_tagged,
    FfmpegError, ProgressCallback,
};
use super::hw_accel::{detect_hardware, HwAccelInfo};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::probe;
use super::progress::{progress_from_times, progress_from_times_with_task};

static AUDIO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Audio:\s+(\w+).*?(\d+)\s*Hz",
    )
    .unwrap()
});
static PIX_FMT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Video:\s+\w+[^,]*,\s*([a-z0-9]+)").unwrap());
static TBN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(\d+(?:\.\d+)?k?)\s*tbn").unwrap());

#[derive(Debug, Error)]
pub enum ProcessorError {
    #[error(transparent)]
    Ffmpeg(#[from] FfmpegError),
    #[error(transparent)]
    Concat(#[from] ConcatError),
    #[error(transparent)]
    Parallel(#[from] ParallelError),
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVideoOptions {
    #[serde(default = "default_intro_dauer")]
    pub dauer: f64,
    #[serde(default = "default_true")]
    pub intro_enabled: bool,
    #[serde(default)]
    pub video_codec: VideoCodecPreference,
    #[serde(default = "default_crf")]
    pub crf: u8,
    /// Parallel body-clip prep / encode (legacy `parallel_processing_enabled`).
    #[serde(default = "default_true")]
    pub parallel_enabled: bool,
}

fn default_intro_dauer() -> f64 {
    DEFAULT_INTRO_DAUER_SECS
}
fn default_true() -> bool {
    true
}
fn default_crf() -> u8 {
    18
}

impl Default for CreateVideoOptions {
    fn default() -> Self {
        Self {
            dauer: DEFAULT_INTRO_DAUER_SECS,
            intro_enabled: true,
            video_codec: VideoCodecPreference::Auto,
            crf: 18,
            parallel_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateVideoResult {
    pub output: String,
    pub encoder: String,
    pub intro_created: bool,
    pub body_clips: usize,
}

/// Scaled usable content box inside the padded background region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentArea {
    pub x_start: i32,
    pub y_start: i32,
    pub usable_width: i32,
    pub usable_height: i32,
}

/// Encoding target matching a body clip (legacy `_get_video_info` subset).
#[derive(Debug, Clone)]
pub struct IntroVideoParams {
    pub width: u32,
    pub height: u32,
    pub fps: String,
    pub timescale: String,
    pub pix_fmt: String,
    pub vcodec: String,
    pub acodec: String,
    pub sample_rate: String,
    pub channel_layout: String,
    #[allow(dead_code)]
    pub has_b_frames: u32,
    #[allow(dead_code)]
    pub profile: Option<String>,
}

impl IntroVideoParams {
    #[allow(dead_code)]
    pub fn for_1080p30(vcodec: &str) -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: "30".into(),
            timescale: "30".into(),
            pix_fmt: "yuv420p".into(),
            vcodec: vcodec.to_string(),
            acodec: "aac".into(),
            sample_rate: "48000".into(),
            channel_layout: "stereo".into(),
            has_b_frames: 0,
            profile: Some("high".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Asset / path helpers
// ---------------------------------------------------------------------------

/// Resolve `resources/assets/<name>` (dev manifest dir or Tauri resource dir).
pub fn find_asset(name: &str, resource_dir: Option<&Path>) -> Result<PathBuf, ProcessorError> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = resource_dir {
        candidates.push(dir.join("assets").join(name));
        candidates.push(dir.join("resources").join("assets").join(name));
        candidates.push(dir.join(name));
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources").join("assets").join(name));

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("resources").join("assets").join(name));
            candidates.push(exe_dir.join("assets").join(name));
        }
    }

    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(ProcessorError::Message(format!(
        "asset not found: {name} (expected under resources/assets/)"
    )))
}

fn work_temp_dir(output: &str) -> Result<PathBuf, ProcessorError> {
    let parent = Path::new(output)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = parent.join(format!(".ats_work_{stamp}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn best_system_font() -> String {
    #[cfg(target_os = "windows")]
    {
        let segoe = [
            r"C:\Windows\Fonts\seguisb.ttf",
            r"C:\Windows\Fonts\segoeuib.ttf",
        ];
        for path in segoe {
            if Path::new(path).is_file() {
                return "Segoe UI Semibold".into();
            }
        }
        "Arial".into()
    }
    #[cfg(target_os = "macos")]
    {
        "Helvetica Neue".into()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "DejaVu Sans".into()
    }
}

// ---------------------------------------------------------------------------
// Content area + drawtext (pure)
// ---------------------------------------------------------------------------

pub fn calculate_scaled_content_area(video_width: u32, video_height: u32) -> ContentArea {
    let bg_aspect = f64::from(HINTERGRUND_ORIGINAL_WIDTH) / f64::from(HINTERGRUND_ORIGINAL_HEIGHT);
    let video_aspect = f64::from(video_width) / f64::from(video_height.max(1));
    let vw = f64::from(video_width);
    let vh = f64::from(video_height);

    let (scaled_bg_width, scaled_bg_height, offset_x, offset_y) = if bg_aspect > video_aspect {
        let w = vw;
        let h = (vw / bg_aspect).floor();
        (w, h, 0.0, (vh - h) / 2.0)
    } else {
        let h = vh;
        let w = (vh * bg_aspect).floor();
        (w, h, (vw - w) / 2.0, 0.0)
    };

    let scale_x = scaled_bg_width / f64::from(HINTERGRUND_ORIGINAL_WIDTH);
    let scale_y = scaled_bg_height / f64::from(HINTERGRUND_ORIGINAL_HEIGHT);

    let content_x1 = CONTENT_AREA_X1 * scale_x + offset_x;
    let content_y1 = CONTENT_AREA_Y1 * scale_y + offset_y;
    let content_x2 = CONTENT_AREA_X2 * scale_x + offset_x;
    let content_y2 = CONTENT_AREA_Y2 * scale_y + offset_y;

    let content_width = content_x2 - content_x1;
    let content_height = content_y2 - content_y1;

    let pad_l = content_width * (CONTENT_AREA_PADDING_LEFT / 100.0);
    let pad_r = content_width * (CONTENT_AREA_PADDING_RIGHT / 100.0);
    let pad_t = content_height * (CONTENT_AREA_PADDING_TOP / 100.0);
    let pad_b = content_height * (CONTENT_AREA_PADDING_BOTTOM / 100.0);

    ContentArea {
        x_start: (content_x1 + pad_l) as i32,
        y_start: (content_y1 + pad_t) as i32,
        usable_width: (content_width - pad_l - pad_r) as i32,
        usable_height: (content_height - pad_t - pad_b) as i32,
    }
}

fn ffmpeg_escape_text(text: &str) -> String {
    text.replace('\\', r"\\")
        .replace(':', r"\:")
        .replace('\'', r"\''")
        .replace(',', r"\,")
}

fn estimate_text_width(text: &str, font_size: i32) -> i32 {
    (text.chars().count() as f64 * f64::from(font_size) * 0.6) as i32
}

fn wrap_text(text: &str, max_width: i32, font_size: i32) -> Vec<String> {
    let words: Vec<&str> = text.split(' ').collect();
    let mut lines = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for word in words {
        let mut test = current.clone();
        test.push(word);
        let joined = test.join(" ");
        if estimate_text_width(&joined, font_size) <= max_width {
            current.push(word);
        } else if current.is_empty() {
            lines.push(word.to_string());
        } else {
            lines.push(current.join(" "));
            current = vec![word];
        }
    }
    if !current.is_empty() {
        lines.push(current.join(" "));
    }
    if lines.is_empty() {
        lines.push(text.to_string());
    }
    lines
}

/// Build comma-joined `drawtext=…` filter chain for the intro overlay.
pub fn prepare_text_overlay(kunde: &Kunde, video_width: u32, video_height: u32) -> String {
    let area = calculate_scaled_content_area(video_width, video_height);
    let font_name = best_system_font();
    let font_escaped = ffmpeg_escape_text(&font_name);
    let gast = kunde.resolve_gast();

    let mut text_data: Vec<(&str, &str)> = vec![
        ("Gast:", gast.as_str()),
        ("Tandemmaster:", kunde.tandemmaster.as_str()),
    ];
    if kunde.is_outside_video() {
        text_data.push(("Videospringer:", kunde.videospringer.as_str()));
    }
    text_data.push(("Datum:", kunde.datum.as_str()));
    text_data.push(("Ort:", kunde.ort.as_str()));

    let font_size = (area.usable_height / 18).max(28);
    let line_height = (f64::from(font_size) * 2.5) as i32;
    let top_padding = (f64::from(area.usable_height) * 0.10) as i32;
    let mut current_y = area.y_start + top_padding;
    let value_x_start = area.x_start + (area.usable_width as f64 * 0.5) as i32;
    let max_value_width = (area.usable_width as f64 * 0.5) as i32;

    let mut cmds = Vec::new();

    for (label, value) in text_data {
        let wrapped = if estimate_text_width(value, font_size) > max_value_width {
            wrap_text(value, max_value_width, font_size)
        } else {
            vec![value.to_string()]
        };

        let label_escaped = ffmpeg_escape_text(label);
        cmds.push(format!(
            "drawtext=text='{label_escaped}':x={}:y={}:fontsize={font_size}:fontcolor=white:borderw=3:bordercolor=black:font='{font_escaped}'",
            area.x_start, current_y
        ));

        let mut value_y = current_y;
        for line in &wrapped {
            let value_escaped = ffmpeg_escape_text(line);
            cmds.push(format!(
                "drawtext=text='{value_escaped}':x={value_x_start}:y={value_y}:fontsize={font_size}:fontcolor=white:borderw=3:bordercolor=black:font='{font_escaped}'"
            ));
            value_y += line_height;
        }

        let lines_used = wrapped.len().max(1) as i32;
        current_y += line_height * lines_used;
    }

    cmds.join(",")
}

fn parse_fps_int(fps: &str) -> u32 {
    let s = fps.trim();
    if s.is_empty() {
        return 30;
    }
    if let Some((n, d)) = s.split_once('/') {
        let num: f64 = n.parse().unwrap_or(30.0);
        let den: f64 = d.parse().unwrap_or(1.0);
        return ((num / den.max(1e-9)).round() as u32).max(1);
    }
    s.parse::<f64>()
        .map(|v| v.round() as u32)
        .unwrap_or(30)
        .max(1)
}

// ---------------------------------------------------------------------------
// Intro FFmpeg command (pure)
// ---------------------------------------------------------------------------

/// Build FFmpeg args for intro from looping background + silent audio + drawtext.
pub fn build_intro_ffmpeg_args(
    hintergrund_path: &str,
    output_path: &str,
    dauer: f64,
    v_params: &IntroVideoParams,
    drawtext_filter: &str,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let video_filters = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
         {drawtext_filter},format={target_pix_fmt}",
        w = v_params.width,
        h = v_params.height,
    );

    let fps_int = parse_fps_int(&v_params.fps);
    let dauer = dauer.max(0.1);
    let force_t = (dauer - 0.05).max(0.0);

    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loop".into(),
        "1".into(),
        "-i".into(),
        hintergrund_path.to_string(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "anullsrc=channel_layout={}:sample_rate={}",
            v_params.channel_layout, v_params.sample_rate
        ),
        "-vf".into(),
        video_filters,
        "-c:v".into(),
        encoder.to_string(),
    ];
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
        "-c:a".into(),
        v_params.acodec.clone(),
        "-t".into(),
        format!("{dauer}"),
        "-shortest".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-force_key_frames".into(),
        format!("expr:eq(n,0)+gte(t,{force_t})"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);

    // Intro-specific quality overrides for software / NVENC (legacy).
    // quality_params already carry CRF/CQ; for intro prefer faster preset when libx264.
    // Callers should pass intro-tuned quality via `intro_quality_params`.

    args
}

/// Intro-tuned quality flags (faster preset / constqp) — without `-c:v`.
pub fn intro_quality_params(encoder: &str, crf: u8, use_hw: bool) -> Vec<String> {
    let enc = encoder.to_ascii_lowercase();
    if !use_hw {
        if enc == "libx265" {
            return vec![
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "20".into(),
            ];
        }
        return vec![
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            crf.max(1).min(51).to_string(),
        ];
    }
    if enc.ends_with("_nvenc") {
        return vec![
            "-rc".into(),
            "constqp".into(),
            "-qp".into(),
            "18".into(),
            "-preset".into(),
            "p2".into(),
            "-no-scenecut".into(),
            "1".into(),
        ];
    }
    if enc.ends_with("_videotoolbox") {
        return vec!["-q:v".into(), "50".into()];
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Probe helpers for intro params
// ---------------------------------------------------------------------------

pub fn intro_params_from_probe(stderr: &str, fallback_codec: &str) -> IntroVideoParams {
    let meta = probe::parse_video_metadata_from_probe(stderr);
    let (width, height, codec, fps_f) = match &meta {
        Some(m) => (m.width, m.height, m.codec.as_str(), m.fps),
        None => (1920, 1080, fallback_codec, 30.0),
    };

    let fps = if fps_f > 0.0 {
        if (fps_f - fps_f.round()).abs() < 0.01 {
            format!("{}", fps_f.round() as u32)
        } else {
            format!("{fps_f}")
        }
    } else {
        "30".into()
    };

    let pix_fmt = PIX_FMT_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        .unwrap_or_else(|| "yuv420p".into());

    let timescale = TBN_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .map(|t| {
            if let Some(stripped) = t.strip_suffix('k').or_else(|| t.strip_suffix('K')) {
                format!("{}", (stripped.parse::<f64>().unwrap_or(90.0) * 1000.0) as u64)
            } else {
                t
            }
        })
        .unwrap_or_else(|| parse_fps_int(&fps).to_string());

    let (acodec, sample_rate) = if let Some(caps) = AUDIO_STREAM_RE.captures(stderr) {
        (
            caps.get(1)
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_else(|| "aac".into()),
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "48000".into()),
        )
    } else {
        ("aac".into(), "48000".into())
    };

    IntroVideoParams {
        width,
        height,
        fps,
        timescale,
        pix_fmt,
        vcodec: if codec.is_empty() {
            fallback_codec.to_string()
        } else {
            codec.to_string()
        },
        acodec,
        sample_rate,
        channel_layout: "stereo".into(),
        has_b_frames: 0,
        profile: None,
    }
}

fn emit_stage(on_progress: &ProgressCallback, stage: f64, stages: f64, label: &str) {
    let pct_secs = (stage / stages) * 100.0;
    on_progress(progress_from_times(pct_secs, 100.0, label));
}

/// Build FFmpeg args for a single body-clip encode (match resolution/fps of `v_params`).
pub fn build_body_clip_encode_args(
    input: &str,
    output: &str,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-vf".into(),
        format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps}",
            w = v_params.width,
            h = v_params.height,
            fps = v_params.fps,
        ),
        "-c:v".into(),
        encoder.to_string(),
    ];
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        v_params.pix_fmt.clone(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        v_params.sample_rate.clone(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Encode multiple body clips in parallel (legacy per_clip + ParallelVideoProcessor).
pub fn encode_body_clips_parallel(
    ffmpeg: &Path,
    inputs: &[String],
    outputs: &[String],
    v_params: &IntroVideoParams,
    hw: &HwAccelInfo,
    crf: u8,
    on_progress: ProgressCallback,
) -> Result<(), ProcessorError> {
    if inputs.len() != outputs.len() {
        return Err(ProcessorError::Message(
            "encode_body_clips_parallel: inputs/outputs length mismatch".into(),
        ));
    }
    if inputs.is_empty() {
        return Ok(());
    }

    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };
    let (encoder, quality) = build_encode_output_params(hw, codec, crf, false);
    // quality includes -c:v; strip for build_body_clip_encode_args which adds encoder itself
    let quality_only: Vec<String> = {
        let mut q = quality;
        if q.first().map(|s| s.as_str()) == Some("-c:v") && q.len() >= 2 {
            q.drain(0..2);
        }
        q
    };

    let pool = ParallelVideoProcessor::new(hw.available);
    let ffmpeg_path = ffmpeg.to_path_buf();
    let inputs_owned = inputs.to_vec();
    let outputs_owned = outputs.to_vec();
    let v_params = v_params.clone();
    let progress = Arc::clone(&on_progress);

    let results = pool.process_indexed(
        inputs_owned.len(),
        |i, task_id| -> Result<(), ProcessorError> {
            if is_cancelled() {
                return Err(ProcessorError::Ffmpeg(FfmpegError::Cancelled));
            }
            let clip_name = Path::new(&inputs_owned[i])
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("Clip {}", i + 1));
            let activity = format!(
                "Clip {task_id}/{total}: {clip_name} — kodieren",
                total = inputs_owned.len()
            );
            let done = format!(
                "Clip {task_id}/{total}: {clip_name} — fertig",
                total = inputs_owned.len()
            );
            let task_progress = {
                let outer = Arc::clone(&progress);
                let activity = activity.clone();
                let done = done.clone();
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
                    if q.status == "end" {
                        q.status = done.clone();
                    } else if q.status == "continue" || q.status.is_empty() {
                        q.status = activity.clone();
                    }
                    outer(q);
                })
            };
            let dur = probe_duration_secs(&ffmpeg_path, &inputs_owned[i]).unwrap_or(0.0);
            progress(progress_from_times_with_task(
                0.0,
                100.0,
                &activity,
                Some(task_id),
            ));
            let args = build_body_clip_encode_args(
                &inputs_owned[i],
                &outputs_owned[i],
                &v_params,
                &encoder,
                &quality_only,
            );
            run_ffmpeg_tagged(
                &ffmpeg_path,
                &args,
                dur,
                Some(task_id),
                task_progress,
            )?;
            progress(progress_from_times_with_task(
                100.0,
                100.0,
                &done,
                Some(task_id),
            ));
            Ok(())
        },
        None,
    )?;

    for r in results {
        r?;
    }
    Ok(())
}

fn body_codecs_compatible(ffmpeg: &Path, paths: &[String]) -> bool {
    if paths.len() < 2 {
        return true;
    }
    let mut first: Option<VideoCodec> = None;
    for p in paths {
        let Ok(stderr) = ffmpeg_probe_stderr(ffmpeg, p) else {
            return false;
        };
        let meta = probe::parse_video_metadata_from_probe(&stderr);
        let codec = meta
            .as_ref()
            .map(|m| concat::normalize_vcodec_name(&m.codec))
            .unwrap_or(VideoCodec::Other);
        if matches!(codec, VideoCodec::Other) {
            return false;
        }
        match first {
            None => first = Some(codec),
            Some(prev) if prev != codec => return false,
            _ => {}
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Create final MP4: optional intro + body clips → `output`.
pub fn create_video(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    output: &str,
    options: &CreateVideoOptions,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
) -> Result<CreateVideoResult, ProcessorError> {
    if video_paths.is_empty() {
        return Err(ProcessorError::Message(
            "at least one video path is required".into(),
        ));
    }
    if output.trim().is_empty() {
        return Err(ProcessorError::Message("output path is required".into()));
    }
    for p in video_paths {
        if !Path::new(p).is_file() {
            return Err(ProcessorError::Message(format!("video not found: {p}")));
        }
    }

    let stages = if options.intro_enabled { 4.0 } else { 3.0 };
    let work = work_temp_dir(output)?;
    let mut encoder_used = String::from("libx264");
    let hw = detect_hardware();

    // Stage 1: body (single path, parallel per-clip encode, or concat)
    emit_stage(&on_progress, 0.0, stages, "Bereite Videoclips vor…");
    let body_path = if video_paths.len() == 1 {
        video_paths[0].clone()
    } else if options.parallel_enabled && !body_codecs_compatible(ffmpeg, video_paths) {
        // Mixed codecs → per_clip encode in parallel, then stream-copy concat
        let pool = ParallelVideoProcessor::new(hw.available);
        on_progress(progress_from_times_with_task(
            0.0,
            100.0,
            &format!(
                "Kodiere {} Clips parallel ({} Worker): unterschiedliche Codecs unter den Clips",
                video_paths.len(),
                pool.max_workers,
            ),
            None,
        ));

        let probe0 = ffmpeg_probe_stderr(ffmpeg, &video_paths[0])?;
        let body_codec_name = probe::parse_video_metadata_from_probe(&probe0)
            .map(|m| m.codec)
            .unwrap_or_else(|| "h264".into());
        let out_codec = resolve_output_codec(options.video_codec, &body_codec_name);
        let mut v_params = intro_params_from_probe(&probe0, &body_codec_name);
        v_params.vcodec = match out_codec {
            VideoCodec::Hevc => "hevc".into(),
            _ => "h264".into(),
        };

        let mut clip_outs = Vec::with_capacity(video_paths.len());
        for i in 0..video_paths.len() {
            clip_outs.push(
                work.join(format!("body_clip_{i}.mp4"))
                    .to_string_lossy()
                    .to_string(),
            );
        }
        encode_body_clips_parallel(
            ffmpeg,
            video_paths,
            &clip_outs,
            &v_params,
            &hw,
            options.crf,
            Arc::clone(&on_progress),
        )?;

        let body_out = work.join("body_concat.mp4");
        let body_out_s = body_out.to_string_lossy().to_string();
        let cb = Arc::clone(&on_progress);
        on_progress(progress_from_times(5.0, 100.0, "Füge kodierte Clips zusammen…"));
        concat::concat_videos(ffmpeg, &clip_outs, &body_out_s, cb)?;
        encoder_used = v_params.vcodec.clone();
        body_out_s
    } else {
        if options.parallel_enabled {
            let pool = ParallelVideoProcessor::new(hw.available);
            on_progress(progress_from_times_with_task(
                0.0,
                100.0,
                &format!(
                    "Füge {} Clips zusammen ({} Worker)…",
                    video_paths.len(),
                    pool.max_workers,
                ),
                None,
            ));
        }
        let body_out = work.join("body_concat.mp4");
        let body_out_s = body_out.to_string_lossy().to_string();
        let cb = Arc::clone(&on_progress);
        concat::concat_videos(ffmpeg, video_paths, &body_out_s, cb)?;
        body_out_s
    };
    emit_stage(&on_progress, 1.0, stages, "Videoclips vorbereitet");

    let body_stderr = ffmpeg_probe_stderr(ffmpeg, &body_path)?;
    let body_meta = probe::parse_video_metadata_from_probe(&body_stderr);
    let body_codec_name = body_meta
        .as_ref()
        .map(|m| m.codec.as_str())
        .unwrap_or("h264");
    let out_codec = resolve_output_codec(options.video_codec, body_codec_name);
    let mut v_params = intro_params_from_probe(&body_stderr, body_codec_name);
    v_params.vcodec = match out_codec {
        VideoCodec::Hevc => "hevc".into(),
        _ => "h264".into(),
    };

    let final_body = if options.intro_enabled {
        // Stage 2: intro
        emit_stage(&on_progress, 1.0, stages, "Erstelle Intro…");
        let hintergrund = find_asset(ASSET_HINTERGRUND, resource_dir)?;
        let drawtext = prepare_text_overlay(kunde, v_params.width, v_params.height);
        let intro_path = work.join("intro.mp4");
        let intro_s = intro_path.to_string_lossy().to_string();

        let intro_cb = {
            let outer = Arc::clone(&on_progress);
            Arc::new(move |p: crate::video::progress::EncodeProgress| {
                let mut q = p;
                if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                    q.status = "Erstelle Intro…".into();
                }
                outer(q);
            })
        };
        create_intro_clip(
            ffmpeg,
            hintergrund.to_string_lossy().as_ref(),
            &intro_s,
            options.dauer,
            &v_params,
            &drawtext,
            &hw,
            options.crf,
            intro_cb,
        )?;
        emit_stage(&on_progress, 2.0, stages, "Intro fertig");

        // Stage 3: mux intro + body
        emit_stage(&on_progress, 2.0, stages, "Füge Intro und Video zusammen…");
        let paths = vec![intro_s, body_path];
        let mux_cb = {
            let outer = Arc::clone(&on_progress);
            Arc::new(move |p: crate::video::progress::EncodeProgress| {
                let mut q = p;
                if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                    q.status = "Füge Intro und Video zusammen…".into();
                } else if q.status == "probing" {
                    q.status = "Analysiere Intro/Video…".into();
                } else if q.status == "mpegts-concat" {
                    q.status = "Füge Intro und Video zusammen…".into();
                } else if q.status == "re-encode" {
                    q.status = "Kodiere Intro+Video neu…".into();
                }
                outer(q);
            })
        };
        let outcome = concat::concat_videos(ffmpeg, &paths, output, mux_cb)?;
        encoder_used = outcome.codec;
        emit_stage(&on_progress, 3.0, stages, "Zusammenfügen fertig");

        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created: true,
            body_clips: video_paths.len(),
        }
    } else {
        // No intro: copy/re-mux body to output via concat of one? Prefer remux or encode.
        emit_stage(&on_progress, 1.0, stages, "Exportiere Video…");
        if Path::new(&body_path) == Path::new(output) {
            // already at destination
        } else {
            let (enc, out_params) =
                build_encode_output_params(&hw, out_codec, options.crf, false);
            encoder_used = enc;
            // Stream-copy when possible: use concat normalize / simple remux
            let mut args = vec![
                "-y".into(),
                "-hide_banner".into(),
                "-i".into(),
                body_path.clone(),
                "-c".into(),
                "copy".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-progress".into(),
                "pipe:1".into(),
                "-nostats".into(),
                output.to_string(),
            ];
            let dur = probe_duration_secs(ffmpeg, &body_path).unwrap_or(0.0);
            let export_cb: ProgressCallback = {
                let outer = Arc::clone(&on_progress);
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
                    if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                        q.status = "Exportiere Video…".into();
                    }
                    outer(q);
                })
            };
            if let Err(e) = run_ffmpeg(ffmpeg, &args, dur, Arc::clone(&export_cb)) {
                // Fallback re-encode
                let _ = e;
                args = vec![
                    "-y".into(),
                    "-hide_banner".into(),
                    "-i".into(),
                    body_path.clone(),
                ];
                args.extend(out_params);
                args.extend([
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "192k".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    "-progress".into(),
                    "pipe:1".into(),
                    "-nostats".into(),
                    output.to_string(),
                ]);
                run_ffmpeg(ffmpeg, &args, dur, export_cb)?;
            } else {
                encoder_used = "copy".into();
            }
        }
        emit_stage(&on_progress, 2.0, stages, "Export fertig");
        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created: false,
            body_clips: video_paths.len(),
        }
    };

    // Best-effort cleanup
    let _ = fs::remove_dir_all(&work);

    on_progress(progress_from_times(100.0, 100.0, "Video fertig"));
    Ok(final_body)
}

fn create_intro_clip(
    ffmpeg: &Path,
    hintergrund: &str,
    output: &str,
    dauer: f64,
    v_params: &IntroVideoParams,
    drawtext: &str,
    hw: &HwAccelInfo,
    crf: u8,
    on_progress: ProgressCallback,
) -> Result<(), ProcessorError> {
    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };

    let mut last_err: Option<ProcessorError> = None;
    for force_sw in [false, true] {
        let (encoder, _) = build_encode_output_params(hw, codec, crf, force_sw);
        let use_hw = hw.available && !force_sw;
        let quality = intro_quality_params(&encoder, crf, use_hw);
        let args = build_intro_ffmpeg_args(
            hintergrund,
            output,
            dauer,
            v_params,
            drawtext,
            &encoder,
            &quality,
        );
        match run_ffmpeg_tagged(ffmpeg, &args, dauer, Some(1), Arc::clone(&on_progress)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(ProcessorError::Ffmpeg(e));
                let _ = fs::remove_file(output);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| ProcessorError::Message("intro encode failed".into())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.gast = "Max Mustermann".into();
        k.tandemmaster = "Anna".into();
        k.videospringer = "Bob".into();
        k.datum = "06.08.2026".into();
        k.ort = "Calden".into();
        k.outside_video = true;
        k
    }

    #[test]
    fn content_area_1080p_is_reasonable() {
        let area = calculate_scaled_content_area(1920, 1080);
        assert!(area.usable_width > 400);
        assert!(area.usable_height > 400);
        assert!(area.x_start >= 0);
        assert!(area.y_start >= 0);
        assert!(area.x_start + area.usable_width <= 1920);
        assert!(area.y_start + area.usable_height <= 1080);
    }

    #[test]
    fn drawtext_contains_labels_and_values() {
        let filter = prepare_text_overlay(&sample_kunde(), 1920, 1080);
        assert!(filter.contains("drawtext="));
        assert!(filter.contains("Gast\\:"));
        // Name may wrap across drawtext lines — check parts.
        assert!(filter.contains("Max"));
        assert!(filter.contains("Mustermann"));
        assert!(filter.contains("Videospringer\\:"));
        assert!(filter.contains("Calden"));
        assert!(filter.contains("fontcolor=white"));
    }

    #[test]
    fn drawtext_hides_videospringer_when_not_outside() {
        let mut k = sample_kunde();
        k.outside_video = false;
        let filter = prepare_text_overlay(&k, 1920, 1080);
        assert!(!filter.contains("Videospringer"));
    }

    #[test]
    fn build_intro_args_structure() {
        let params = IntroVideoParams::for_1080p30("h264");
        let draw = "drawtext=text='Gast\\:':x=10:y=10:fontsize=28:fontcolor=white";
        let quality = intro_quality_params("libx264", 18, false);
        let args = build_intro_ffmpeg_args(
            r"C:\assets\hintergrund.png",
            r"C:\out\intro.mp4",
            5.0,
            &params,
            draw,
            "libx264",
            &quality,
        );

        assert!(args.contains(&"-loop".into()));
        assert!(args.contains(&"1".into()));
        assert!(args.contains(&"-i".into()));
        assert!(args.iter().any(|a| a.contains("hintergrund.png")));
        assert!(args.iter().any(|a| a.starts_with("anullsrc=")));
        assert!(args.contains(&"-vf".into()));
        assert!(args.iter().any(|a| a.contains("drawtext=")));
        assert!(args.contains(&"-c:v".into()));
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"-t".into()));
        assert!(args.contains(&"5".into()) || args.iter().any(|a| a.starts_with('5')));
        assert!(args.contains(&"-progress".into()));
        assert_eq!(args.last().unwrap(), r"C:\out\intro.mp4");
    }

    #[test]
    fn intro_params_from_probe_stderr() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'body.mp4':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 7970 kb/s, 30 fps, 30 tbr, 90k tbn
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
"#;
        let p = intro_params_from_probe(stderr, "h264");
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        assert_eq!(p.pix_fmt, "yuv420p");
        assert_eq!(p.sample_rate, "48000");
        assert_eq!(p.acodec, "aac");
        assert_eq!(p.timescale, "90000");
    }

    #[test]
    fn find_asset_hintergrund_in_dev() {
        let path = find_asset(ASSET_HINTERGRUND, None).expect("hintergrund.png");
        assert!(path.exists());
        assert!(path.file_name().unwrap() == "hintergrund.png");
    }

    #[test]
    fn ffmpeg_escape_colon() {
        assert_eq!(ffmpeg_escape_text("a:b"), r"a\:b");
    }

    #[test]
    fn build_body_clip_encode_args_structure() {
        let params = IntroVideoParams::for_1080p30("h264");
        let quality = vec!["-preset".into(), "medium".into(), "-crf".into(), "18".into()];
        let args = build_body_clip_encode_args("in.mp4", "out.mp4", &params, "libx264", &quality);
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"in.mp4".into()));
        assert!(args.contains(&"-c:v".into()));
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"-progress".into()));
        assert!(args.iter().any(|a| a.contains("scale=1920:1080")));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }
}
