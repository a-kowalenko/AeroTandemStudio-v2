//! Preview encode target matching & fast preview pipeline
//! (behaviour port of legacy `preview_encode_target.py` + preview re-encode).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::Kunde;
use crate::storage::AppConfig;

use super::concat::{self, ConcatError, VideoCodec};
use super::encoding_quality::{
    build_encode_output_params, build_hw_quality_params, build_software_quality_params, clamp_crf,
    select_encoder, strip_hwaccel_input_params, VideoCodecPreference,
};
use super::ffmpeg::{
    disk_full_error, ffmpeg_probe_stderr, is_cancelled, is_disk_full_error, probe_duration_secs,
    run_ffmpeg, FfmpegError, ProgressCallback,
};
use super::hw_accel::{detect_hardware, EncodingParams, HwAccelInfo};
use super::probe;
use super::preview_reuse;
use super::processor::{self, CreateVideoOptions, ProcessorError};
use super::progress::{progress_from_times, progress_from_times_with_task};

static PIX_FMT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Video:\s+\w+[^,]*,\s*([a-z0-9]+)").unwrap());

pub const PREVIEW_WIDTH: u32 = 1920;
pub const PREVIEW_HEIGHT: u32 = 1080;
pub const PREVIEW_FPS: f64 = 30.0;

#[derive(Debug, Error)]
pub enum PreviewError {
    #[error(transparent)]
    Ffmpeg(#[from] FfmpegError),
    #[error(transparent)]
    Concat(#[from] ConcatError),
    #[error(transparent)]
    Processor(#[from] ProcessorError),
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Probed clip fields used for preview-target decisions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreviewClipFormat {
    pub codec_name: String,
    pub width: u32,
    pub height: u32,
    /// Raw rate string (`30/1`, `30000/1001`) or decimal fps string.
    pub r_frame_rate: String,
    pub pix_fmt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PreviewClipFormat {
    pub fn from_probe_meta(meta: &probe::ParsedStreamMeta, pix_fmt: &str, fps_fallback: f64) -> Self {
        let rate = if meta.fps > 0.0 {
            format_fps_as_rate(meta.fps)
        } else if fps_fallback > 0.0 {
            format_fps_as_rate(fps_fallback)
        } else {
            "0/0".into()
        };
        Self {
            codec_name: meta.codec.clone(),
            width: meta.width,
            height: meta.height,
            r_frame_rate: rate,
            pix_fmt: pix_fmt.to_string(),
            error: None,
        }
    }

    pub fn with_error(msg: impl Into<String>) -> Self {
        Self {
            codec_name: String::new(),
            width: 0,
            height: 0,
            r_frame_rate: "0/0".into(),
            pix_fmt: String::new(),
            error: Some(msg.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreviewFormatInfo {
    pub compatible: bool,
    pub details: String,
    pub formats: Vec<PreviewClipFormat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStrategy {
    StreamCopyOnly,
    PerClip,
    Combined,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EncodingPlan {
    pub strategy: PreviewStrategy,
    pub needs_clip_reencoding: bool,
    pub needs_combined_reencoding: bool,
    pub target_codec: Option<String>,
    /// Human-readable German reason when any re-encode is planned; `None` for stream-copy.
    pub reencode_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewResult {
    pub preview_path: String,
    pub work_dir: String,
    pub strategy: String,
    pub target_codec: Option<String>,
    pub encoder: String,
    pub intro_included: bool,
    pub clip_count: usize,
    /// Fingerprint of form + clips at generate time (for final create reuse).
    pub fingerprint: String,
    /// Why clips/combined video were re-encoded; `None` when stream-copy only.
    pub reencode_reason: Option<String>,
}

fn format_fps_as_rate(fps: f64) -> String {
    if (fps - 29.97).abs() < 0.05 {
        "30000/1001".into()
    } else if (fps - fps.round()).abs() < 0.01 {
        format!("{}/1", fps.round() as i32)
    } else {
        format!("{fps}")
    }
}

/// Normalize ffprobe / settings codec names for comparisons (`h265` / `hevc` → `h265`).
pub fn normalize_target_codec(codec_name: Option<&str>) -> String {
    let Some(raw) = codec_name.filter(|s| !s.trim().is_empty()) else {
        return "h264".into();
    };
    let name = raw.trim().to_ascii_lowercase();
    match name.as_str() {
        "hevc" | "h265" | "hev1" | "hvc1" => "h265".into(),
        "h264" | "avc" | "avc1" => "h264".into(),
        other => other.to_string(),
    }
}

/// True when frame rate is ~30 or ~29.97 fps.
pub fn fps_matches_preview_target(r_frame_rate: &str) -> bool {
    if r_frame_rate.is_empty() || r_frame_rate == "0/0" {
        return false;
    }
    let fps = parse_frame_rate(r_frame_rate);
    match fps {
        Some(v) => (v - 30.0).abs() < 0.05 || (v - 29.97).abs() < 0.05,
        None => false,
    }
}

pub fn parse_frame_rate(r_frame_rate: &str) -> Option<f64> {
    let rate = r_frame_rate.trim();
    if rate.is_empty() || rate == "0/0" {
        return None;
    }
    if let Some((num_s, den_s)) = rate.split_once('/') {
        let num: f64 = num_s.parse().ok()?;
        let den: f64 = den_s.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        Some(num / den)
    } else {
        rate.parse().ok()
    }
}

fn browser_safe_pix_fmts(vcodec: &str) -> &'static [&'static str] {
    match normalize_vcodec_for_browser(vcodec) {
        "hevc" => &["yuv420p", "yuv420p10le"],
        _ => &["yuv420p", "yuvj420p"],
    }
}

fn normalize_vcodec_for_browser(codec_name: &str) -> &'static str {
    match normalize_target_codec(Some(codec_name)).as_str() {
        "h265" => "hevc",
        _ => "h264",
    }
}

/// True when pix_fmt is not browser-safe for stream-copy preview.
pub fn pix_fmt_needs_reencode_for_browser(pix_fmt: Option<&str>, vcodec: &str) -> bool {
    let Some(pix) = pix_fmt.filter(|p| !p.is_empty()) else {
        return false;
    };
    !browser_safe_pix_fmts(vcodec).contains(&pix)
}

fn clip_matches_resolution_and_fps(fmt: &PreviewClipFormat) -> bool {
    if fmt.error.is_some() {
        return false;
    }
    if fmt.width != PREVIEW_WIDTH || fmt.height != PREVIEW_HEIGHT {
        return false;
    }
    fps_matches_preview_target(&fmt.r_frame_rate)
}

/// True when clip is already 1080p@30 in H.264/HEVC with browser-safe pix_fmt.
pub fn clip_matches_preview_target(fmt: &PreviewClipFormat) -> bool {
    if !clip_matches_resolution_and_fps(fmt) {
        return false;
    }
    let codec = normalize_target_codec(Some(&fmt.codec_name));
    if codec != "h264" && codec != "h265" {
        return false;
    }
    let vcodec = if codec == "h265" { "hevc" } else { "h264" };
    !pix_fmt_needs_reencode_for_browser(Some(&fmt.pix_fmt), vcodec)
}

pub fn all_clips_match_preview_target(format_info: &PreviewFormatInfo) -> bool {
    let valid: Vec<_> = format_info
        .formats
        .iter()
        .filter(|f| f.error.is_none())
        .collect();
    if valid.is_empty() {
        return false;
    }
    valid.iter().all(|f| clip_matches_preview_target(f))
}

/// AUTO target codec from source clips (all same → that codec; mixed → first).
pub fn resolve_auto_target_codec(format_info: &PreviewFormatInfo, default: &str) -> String {
    let valid: Vec<_> = format_info
        .formats
        .iter()
        .filter(|f| f.error.is_none())
        .collect();
    if valid.is_empty() {
        return normalize_target_codec(Some(default));
    }
    let codecs: Vec<String> = valid
        .iter()
        .map(|f| normalize_target_codec(Some(&f.codec_name)))
        .collect();
    let unique: std::collections::HashSet<&String> = codecs.iter().collect();
    if unique.len() == 1 {
        codecs[0].clone()
    } else {
        codecs[0].clone()
    }
}

pub fn clips_match_target_codec(format_info: &PreviewFormatInfo, target_codec: &str) -> bool {
    let normalized_target = normalize_target_codec(Some(target_codec));
    let valid: Vec<_> = format_info
        .formats
        .iter()
        .filter(|f| f.error.is_none())
        .collect();
    if valid.is_empty() {
        return false;
    }
    valid
        .iter()
        .all(|f| normalize_target_codec(Some(&f.codec_name)) == normalized_target)
}

fn stream_copy_encoding_plan() -> EncodingPlan {
    EncodingPlan {
        strategy: PreviewStrategy::StreamCopyOnly,
        needs_clip_reencoding: false,
        needs_combined_reencoding: false,
        target_codec: None,
        reencode_reason: None,
    }
}

/// German explanation when clips are not stream-copy compatible with each other.
fn incompatible_clips_reason(format_info: &PreviewFormatInfo) -> String {
    if format_info.details.trim().is_empty() {
        "Clips nicht stream-copy-kompatibel (unterschiedliche Codecs oder Auflösungen)".into()
    } else {
        format_info.details.clone()
    }
}

/// German explanation why a forced codec / strategy requires re-encoding.
fn forced_codec_reencode_reason(
    format_info: &PreviewFormatInfo,
    target_codec: &str,
    strategy: &str,
    reencode_matching_clips: bool,
    combined: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    if reencode_matching_clips {
        parts.push("Einstellung „Passende Clips neu encodieren“ ist aktiv".into());
    }

    if !clips_match_target_codec(format_info, target_codec) {
        parts.push(format!(
            "Ziel-Codec {target_codec} weicht vom Quell-Codec ab"
        ));
    }

    if !format_info.compatible {
        parts.push(incompatible_clips_reason(format_info));
    }

    if combined {
        parts.push(format!(
            "Encoding-Strategie „kombiniert“ mit festem Codec {target_codec}"
        ));
    } else if strategy == "combined" && !format_info.compatible {
        parts.push(
            "Strategie „kombiniert“ nicht möglich → Fallback auf Pro-Clip-Kodierung".into(),
        );
    }

    if parts.is_empty() {
        // Clips match target codec & each other, but not 1080p@30 preview target,
        // and force_codec path still chose re-encode (e.g. combined after mismatch
        // already covered). Generic fallback.
        if !all_clips_match_preview_target(format_info) {
            parts.push(
                "Clips entsprechen nicht dem Preview-Ziel (1080p@30, browser-sicheres Format)"
                    .into(),
            );
        } else {
            parts.push(format!("Neu-Kodierung auf Ziel-Codec {target_codec}"));
        }
    }

    parts.join("; ")
}

/// Decide clip vs combined encoding from codec preference, strategy, and compatibility.
pub fn resolve_encoding_plan(
    selected_codec: &str,
    encoding_strategy: &str,
    format_info: &PreviewFormatInfo,
    reencode_matching_clips: bool,
) -> EncodingPlan {
    let compatible = format_info.compatible;
    let force_codec = selected_codec != "auto";
    let strategy = if encoding_strategy == "combined" {
        "combined"
    } else {
        "per_clip"
    };

    if all_clips_match_preview_target(format_info) {
        return stream_copy_encoding_plan();
    }

    if !force_codec {
        if compatible {
            return stream_copy_encoding_plan();
        }
        let auto_codec = resolve_auto_target_codec(format_info, "h264");
        return EncodingPlan {
            strategy: PreviewStrategy::PerClip,
            needs_clip_reencoding: true,
            needs_combined_reencoding: false,
            target_codec: Some(auto_codec),
            reencode_reason: Some(incompatible_clips_reason(format_info)),
        };
    }

    let target_codec = selected_codec.to_string();
    if compatible
        && !reencode_matching_clips
        && clips_match_target_codec(format_info, &target_codec)
    {
        return stream_copy_encoding_plan();
    }

    if strategy == "combined" && compatible {
        return EncodingPlan {
            strategy: PreviewStrategy::Combined,
            needs_clip_reencoding: false,
            needs_combined_reencoding: true,
            target_codec: Some(target_codec.clone()),
            reencode_reason: Some(forced_codec_reencode_reason(
                format_info,
                &target_codec,
                strategy,
                reencode_matching_clips,
                true,
            )),
        };
    }

    EncodingPlan {
        strategy: PreviewStrategy::PerClip,
        needs_clip_reencoding: true,
        needs_combined_reencoding: false,
        target_codec: Some(target_codec.clone()),
        reencode_reason: Some(forced_codec_reencode_reason(
            format_info,
            &target_codec,
            strategy,
            reencode_matching_clips,
            false,
        )),
    }
}

/// True when scale/pad/fps filter is required before encode.
pub fn clip_needs_video_filter(fmt: Option<&PreviewClipFormat>) -> bool {
    let Some(fmt) = fmt else {
        return true;
    };
    if fmt.error.is_some() {
        return true;
    }
    if fmt.width != PREVIEW_WIDTH || fmt.height != PREVIEW_HEIGHT {
        return true;
    }
    if !fps_matches_preview_target(&fmt.r_frame_rate) {
        return true;
    }
    if pix_fmt_needs_reencode_for_browser(Some(&fmt.pix_fmt), &fmt.codec_name) {
        return true;
    }
    let codec = normalize_vcodec_for_browser(&fmt.codec_name);
    if codec == "hevc" {
        return !matches!(fmt.pix_fmt.as_str(), "yuv420p" | "yuv420p10le");
    }
    if !fmt.pix_fmt.is_empty() && !matches!(fmt.pix_fmt.as_str(), "yuv420p" | "yuvj420p") {
        return true;
    }
    false
}

fn target_codec_to_video_codec(codec: &str) -> VideoCodec {
    match normalize_target_codec(Some(codec)).as_str() {
        "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    }
}

/// Build FFmpeg args for a preview re-encode (1080p@30, AAC, CRF from config).
/// Does not include the `ffmpeg` binary itself.
pub fn build_preview_reencode_args(
    input: &str,
    output: &str,
    codec_to_use: &str,
    source_fmt: Option<&PreviewClipFormat>,
    hw: &HwAccelInfo,
    hw_accel_enabled: bool,
    preview_crf: u8,
) -> Vec<String> {
    let hevc_target = target_codec_to_video_codec(codec_to_use) == VideoCodec::Hevc;
    let source_pix = source_fmt.map(|f| f.pix_fmt.as_str()).unwrap_or("");
    let target_pix_fmt = if hevc_target && source_pix.contains('1') && source_pix.contains('0') {
        "yuv420p10le"
    } else {
        "yuv420p"
    };

    let video_codec = target_codec_to_video_codec(codec_to_use);
    let force_software = !hw_accel_enabled || !hw.available;
    let encoder = if force_software {
        match video_codec {
            VideoCodec::Hevc => "libx265".to_string(),
            _ => "libx264".to_string(),
        }
    } else {
        select_encoder(hw, video_codec)
    };

    let use_hw_encode = hw_accel_enabled
        && hw.available
        && !encoder.starts_with("lib");
    let needs_vf = clip_needs_video_filter(source_fmt);

    let enc_params = EncodingParams::from_hw(hw, use_hw_encode && !needs_vf);
    let mut input_params = enc_params.input_params.clone();
    if needs_vf && use_hw_encode {
        input_params = strip_hwaccel_input_params(&input_params);
    }

    let crf = clamp_crf(i32::from(preview_crf), 18);
    let quality = if use_hw_encode {
        build_hw_quality_params(hw, &encoder, crf, video_codec)
    } else {
        build_software_quality_params(&encoder, crf, video_codec)
    };

    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-err_detect".into(),
        "ignore_err".into(),
        "-fflags".into(),
        "+genpts+igndts".into(),
    ];
    args.extend(input_params);
    args.extend(["-i".into(), input.to_string()]);

    if needs_vf {
        let filter_chain = format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease:flags=fast_bilinear,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,\
             fps={fps},format={pix}",
            w = PREVIEW_WIDTH,
            h = PREVIEW_HEIGHT,
            fps = PREVIEW_FPS as u32,
            pix = target_pix_fmt,
        );
        args.extend(["-vf".into(), filter_chain]);
    }

    args.extend(["-c:v".into(), encoder]);
    args.extend(["-pix_fmt".into(), target_pix_fmt.into()]);
    if hevc_target {
        args.extend(["-profile:v".into(), "main".into()]);
    }
    args.extend(quality);
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-max_muxing_queue_size".into(),
        "1024".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

fn parse_pix_fmt(stderr: &str) -> String {
    PIX_FMT_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        .unwrap_or_else(|| "yuv420p".into())
}

/// Probe clip formats and rough concat compatibility (same codec + resolution).
pub fn probe_preview_formats(
    ffmpeg: &Path,
    paths: &[String],
) -> Result<PreviewFormatInfo, PreviewError> {
    let mut formats = Vec::with_capacity(paths.len());
    for path in paths {
        match ffmpeg_probe_stderr(ffmpeg, path) {
            Ok(stderr) => {
                let pix = parse_pix_fmt(&stderr);
                match probe::parse_video_metadata_from_probe(&stderr) {
                    Some(meta) => {
                        formats.push(PreviewClipFormat::from_probe_meta(&meta, &pix, meta.fps));
                    }
                    None => formats.push(PreviewClipFormat::with_error("no video stream")),
                }
            }
            Err(e) => formats.push(PreviewClipFormat::with_error(e.to_string())),
        }
    }

    let valid: Vec<_> = formats.iter().filter(|f| f.error.is_none()).collect();
    if valid.is_empty() {
        return Ok(PreviewFormatInfo {
            compatible: false,
            details: "Keine gültigen Clips".into(),
            formats,
        });
    }

    let first = valid[0];
    let mut compatible = true;
    let mut details = String::new();
    for fmt in &valid[1..] {
        if normalize_target_codec(Some(&fmt.codec_name))
            != normalize_target_codec(Some(&first.codec_name))
            || fmt.width != first.width
            || fmt.height != first.height
        {
            compatible = false;
            details = format!(
                "Format-Unterschied: {} {}x{} vs {} {}x{}",
                first.codec_name,
                first.width,
                first.height,
                fmt.codec_name,
                fmt.width,
                fmt.height
            );
            break;
        }
    }

    Ok(PreviewFormatInfo {
        compatible,
        details,
        formats,
    })
}

/// Create a temporary working directory for preview encodes.
pub fn create_preview_work_dir() -> Result<PathBuf, PreviewError> {
    let base = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = base.join(format!("aero_studio_preview_{stamp}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn strategy_label(plan: &EncodingPlan) -> String {
    match plan.strategy {
        PreviewStrategy::StreamCopyOnly => "stream_copy_only".into(),
        PreviewStrategy::PerClip => "per_clip".into(),
        PreviewStrategy::Combined => "combined".into(),
    }
}

fn reencode_one(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    codec: &str,
    source_fmt: Option<&PreviewClipFormat>,
    hw: &HwAccelInfo,
    hw_accel_enabled: bool,
    crf: u8,
    on_progress: ProgressCallback,
    task_id: Option<u32>,
) -> Result<(), PreviewError> {
    if is_cancelled() {
        return Err(PreviewError::Ffmpeg(FfmpegError::Cancelled));
    }
    let args = build_preview_reencode_args(
        input,
        output,
        codec,
        source_fmt,
        hw,
        hw_accel_enabled,
        crf,
    );
    let dur = probe_duration_secs(ffmpeg, input).unwrap_or(0.0);
    let cb = if let Some(tid) = task_id {
        let inner = Arc::clone(&on_progress);
        Arc::new(move |p: crate::video::progress::EncodeProgress| {
            inner(progress_from_times_with_task(
                p.current_secs,
                p.total_secs.max(dur),
                &p.status,
                Some(tid),
            ));
        }) as ProgressCallback
    } else {
        Arc::clone(&on_progress)
    };
    run_ffmpeg(ffmpeg, &args, dur, cb)?;
    Ok(())
}

/// Generate a combined preview MP4 in a temp work dir.
///
/// When `config.intro_enabled`, builds a full preview via [`processor::create_video`]
/// (kunde → intro text). Otherwise prepares body clips (stream-copy or re-encode)
/// and concatenates them.
pub fn generate_preview(
    ffmpeg: &Path,
    video_paths: &[String],
    kunde: &Kunde,
    config: &AppConfig,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
) -> Result<PreviewResult, PreviewError> {
    if video_paths.is_empty() {
        return Err(PreviewError::Message(
            "at least one video path is required".into(),
        ));
    }
    for p in video_paths {
        if !Path::new(p).is_file() {
            return Err(PreviewError::Message(format!("video not found: {p}")));
        }
    }

    let work = create_preview_work_dir()?;
    let crf = clamp_crf(i32::from(config.preview_encode_crf), 18);
    let hw = detect_hardware();
    let hw_accel_enabled = config.hardware_acceleration_enabled;
    let enc_tag = preview_reuse::preview_encoding_tag(
        config.intro_enabled,
        f64::from(config.dauer),
        &config.intro_mux_mode,
    );
    let fingerprint =
        preview_reuse::create_content_fingerprint_with_tag(kunde, video_paths, &enc_tag)
            .map_err(PreviewError::Message)?;

    on_progress(progress_from_times(0.0, 100.0, "preview-analyse"));
    let format_info = probe_preview_formats(ffmpeg, video_paths)?;
    let plan = resolve_encoding_plan(
        &config.video_codec,
        &config.encoding_strategy,
        &format_info,
        config.reencode_matching_clips,
    );

    // Intro path: reuse create_video into the work dir (kunde drives overlay text).
    if config.intro_enabled {
        let intro_reason = plan.reencode_reason.clone().unwrap_or_else(|| {
            "Intro-Overlay erfordert Kodierung".into()
        });
        on_progress(progress_from_times(
            5.0,
            100.0,
            &format!("Vorschau-Intro: {intro_reason}"),
        ));
        let out = work.join("preview_with_intro.mp4");
        let out_s = out.to_string_lossy().to_string();
        let codec_pref = VideoCodecPreference::parse(&config.video_codec);
        let opts = CreateVideoOptions {
            dauer: f64::from(config.dauer),
            intro_enabled: true,
            video_codec: codec_pref,
            crf,
            parallel_enabled: config.parallel_processing_enabled,
            intro_mux_mode: config.intro_mux_mode.clone(),
            body_concat_mode: config.body_concat_mode.clone(),
            hw_accel_enabled: config.hardware_acceleration_enabled,
        };
        let result = processor::create_video(
            ffmpeg,
            kunde,
            video_paths,
            &out_s,
            &opts,
            resource_dir,
            Arc::clone(&on_progress),
            None,
            None,
        )?;
        on_progress(progress_from_times(100.0, 100.0, "end"));
        return Ok(PreviewResult {
            preview_path: result.output,
            work_dir: work.to_string_lossy().into_owned(),
            strategy: strategy_label(&plan),
            target_codec: plan.target_codec.clone(),
            encoder: result.encoder,
            intro_included: true,
            clip_count: video_paths.len(),
            fingerprint,
            reencode_reason: Some(intro_reason),
        });
    }

    // Body-only preview
    let target_codec = plan
        .target_codec
        .clone()
        .unwrap_or_else(|| resolve_auto_target_codec(&format_info, "h264"));

    let mut active_reason = plan.reencode_reason.clone();

    let prepared: Vec<String> = if plan.needs_clip_reencoding {
        let reason = active_reason
            .clone()
            .unwrap_or_else(|| "Clips werden neu kodiert".into());
        on_progress(progress_from_times(
            10.0,
            100.0,
            &format!("Kodiere Vorschau-Clips neu: {reason}"),
        ));
        let mut outs = Vec::with_capacity(video_paths.len());
        let use_task_ids = config.parallel_processing_enabled && video_paths.len() > 1;
        let n_clips = video_paths.len().max(1) as f64;
        for (i, path) in video_paths.iter().enumerate() {
            if is_cancelled() {
                return Err(PreviewError::Ffmpeg(FfmpegError::Cancelled));
            }
            let out = work.join(format!("clip_{i}.mp4"));
            let out_s = out.to_string_lossy().to_string();
            let fmt = format_info.formats.get(i);
            let task_id = if use_task_ids {
                Some((i + 1) as u32)
            } else {
                None
            };
            let clip_name = Path::new(path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("Clip {}", i + 1));
            let activity = if use_task_ids {
                format!(
                    "Clip {}/{}: {clip_name} — Vorschau kodieren",
                    i + 1,
                    video_paths.len()
                )
            } else {
                format!("Kodiere Vorschau-Clip: {clip_name}")
            };
            // Overall 10–70% across clips so the main bar moves without averaging task events.
            let clip_cb: ProgressCallback = {
                let outer = Arc::clone(&on_progress);
                let activity = activity.clone();
                let i = i as f64;
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
                    if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                        q.status = activity.clone();
                    }
                    if let Some(tid) = task_id {
                        q.task_id = Some(tid);
                        outer(q.clone());
                        let frac = (i + q.percent.clamp(0.0, 100.0) / 100.0) / n_clips;
                        outer(crate::video::progress::EncodeProgress {
                            percent: 10.0 + frac * 60.0,
                            current_secs: q.current_secs,
                            total_secs: q.total_secs,
                            status: activity.clone(),
                            task_id: None,
                        });
                    } else {
                        q.percent = 10.0 + (i + q.percent.clamp(0.0, 100.0) / 100.0) / n_clips * 60.0;
                        outer(q);
                    }
                })
            };
            reencode_one(
                ffmpeg,
                path,
                &out_s,
                &target_codec,
                fmt,
                &hw,
                hw_accel_enabled,
                crf,
                clip_cb,
                None, // task_id applied in clip_cb
            )?;
            outs.push(out_s);
        }
        outs
    } else {
        // Stream-copy path: use originals (or remux copies into work dir for stability)
        on_progress(progress_from_times(10.0, 100.0, "preview-copy"));
        video_paths.to_vec()
    };

    let combined = work.join("preview_combined.mp4");
    let combined_s = combined.to_string_lossy().to_string();

    on_progress(progress_from_times(70.0, 100.0, "preview-concat"));
    let mut encoder_used = target_codec.clone();

    if prepared.len() == 1 {
        if plan.needs_combined_reencoding {
            let reason = active_reason
                .clone()
                .unwrap_or_else(|| "Kombinierte Neu-Kodierung".into());
            on_progress(progress_from_times(
                75.0,
                100.0,
                &format!("Kodiere kombiniert neu: {reason}"),
            ));
            reencode_one(
                ffmpeg,
                &prepared[0],
                &combined_s,
                &target_codec,
                None,
                &hw,
                hw_accel_enabled,
                crf,
                Arc::clone(&on_progress),
                None,
            )?;
            let (enc, _) =
                build_encode_output_params(&hw, target_codec_to_video_codec(&target_codec), crf, !hw_accel_enabled);
            encoder_used = enc;
        } else if Path::new(&prepared[0]) == combined.as_path() {
            // unreachable
        } else {
            // Remux single clip into preview path
            let args = vec![
                "-y".into(),
                "-hide_banner".into(),
                "-i".into(),
                prepared[0].clone(),
                "-c".into(),
                "copy".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-progress".into(),
                "pipe:1".into(),
                "-nostats".into(),
                combined_s.clone(),
            ];
            let dur = probe_duration_secs(ffmpeg, &prepared[0]).unwrap_or(0.0);
            if let Err(e) = run_ffmpeg(ffmpeg, &args, dur, Arc::clone(&on_progress)) {
                if is_disk_full_error(&e) {
                    return Err(PreviewError::Ffmpeg(disk_full_error()));
                }
                let remux_reason =
                    "Remux (Stream-Copy) fehlgeschlagen → Neu-Kodierung als Fallback".to_string();
                active_reason = Some(remux_reason.clone());
                on_progress(progress_from_times(
                    75.0,
                    100.0,
                    &format!("Kodiere neu: {remux_reason}"),
                ));
                reencode_one(
                    ffmpeg,
                    &prepared[0],
                    &combined_s,
                    &target_codec,
                    None,
                    &hw,
                    hw_accel_enabled,
                    crf,
                    Arc::clone(&on_progress),
                    None,
                )?;
            }
        }
    } else {
        let outcome = concat::concat_videos_with_opts(
            ffmpeg,
            &prepared,
            &combined_s,
            Arc::clone(&on_progress),
            hw_accel_enabled,
            crf,
            &config.body_concat_mode,
            None, // preview: silent legacy fallback if fast fails
        )?;
        encoder_used = outcome.codec;
        if outcome.method == "re-encode" {
            let concat_reason = outcome
                .reencode_reason
                .clone()
                .unwrap_or_else(|| "Concat erforderte Neu-Kodierung".into());
            active_reason = Some(match active_reason {
                Some(prev) => format!("{prev}; {concat_reason}"),
                None => concat_reason,
            });
        }
        if plan.needs_combined_reencoding {
            let reason = plan
                .reencode_reason
                .clone()
                .unwrap_or_else(|| "Kombinierte Neu-Kodierung nach Concat".into());
            active_reason = Some(reason.clone());
            on_progress(progress_from_times(
                85.0,
                100.0,
                &format!("Kodiere kombiniert neu: {reason}"),
            ));
            let reenc = work.join("preview_combined_encoded.mp4");
            let reenc_s = reenc.to_string_lossy().to_string();
            reencode_one(
                ffmpeg,
                &combined_s,
                &reenc_s,
                &target_codec,
                None,
                &hw,
                hw_accel_enabled,
                crf,
                Arc::clone(&on_progress),
                None,
            )?;
            // Replace combined with re-encoded
            let _ = fs::remove_file(&combined);
            fs::rename(&reenc, &combined)?;
            let (enc, _) =
                build_encode_output_params(&hw, target_codec_to_video_codec(&target_codec), crf, !hw_accel_enabled);
            encoder_used = enc;
        }
    }

    if is_cancelled() {
        return Err(PreviewError::Ffmpeg(FfmpegError::Cancelled));
    }

    on_progress(progress_from_times(100.0, 100.0, "end"));
    Ok(PreviewResult {
        preview_path: combined_s,
        work_dir: work.to_string_lossy().into_owned(),
        strategy: strategy_label(&plan),
        target_codec: Some(target_codec),
        encoder: encoder_used,
        intro_included: false,
        clip_count: video_paths.len(),
        fingerprint,
        reencode_reason: active_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h264_1080p30() -> PreviewClipFormat {
        PreviewClipFormat {
            codec_name: "h264".into(),
            width: 1920,
            height: 1080,
            r_frame_rate: "30/1".into(),
            pix_fmt: "yuv420p".into(),
            error: None,
        }
    }

    #[test]
    fn normalize_target_codec_hevc() {
        assert_eq!(normalize_target_codec(Some("hevc")), "h265");
        assert_eq!(normalize_target_codec(Some("H265")), "h265");
        assert_eq!(normalize_target_codec(None), "h264");
    }

    #[test]
    fn fps_matches_30_and_2997() {
        assert!(fps_matches_preview_target("30/1"));
        assert!(fps_matches_preview_target("30000/1001"));
        assert!(fps_matches_preview_target("30"));
        assert!(!fps_matches_preview_target("60/1"));
        assert!(!fps_matches_preview_target("0/0"));
    }

    #[test]
    fn clip_matches_preview_target_ok() {
        assert!(clip_matches_preview_target(&h264_1080p30()));
    }

    #[test]
    fn wrong_resolution_fails() {
        let mut fmt = h264_1080p30();
        fmt.width = 3840;
        fmt.height = 2160;
        assert!(!clip_matches_preview_target(&fmt));
    }

    #[test]
    fn hevc_clip_matches() {
        let fmt = PreviewClipFormat {
            codec_name: "hevc".into(),
            width: 1920,
            height: 1080,
            r_frame_rate: "30/1".into(),
            pix_fmt: "yuv420p".into(),
            error: None,
        };
        assert!(clip_matches_preview_target(&fmt));
    }

    #[test]
    fn resolve_auto_target_codec_hevc() {
        let info = PreviewFormatInfo {
            compatible: true,
            details: String::new(),
            formats: vec![
                PreviewClipFormat {
                    codec_name: "hevc".into(),
                    width: 3840,
                    height: 2160,
                    r_frame_rate: "30/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
                PreviewClipFormat {
                    codec_name: "h265".into(),
                    width: 3840,
                    height: 2160,
                    r_frame_rate: "30/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
            ],
        };
        assert_eq!(resolve_auto_target_codec(&info, "h264"), "h265");
    }

    #[test]
    fn resolve_auto_mixed_uses_first() {
        let info = PreviewFormatInfo {
            compatible: false,
            details: String::new(),
            formats: vec![
                PreviewClipFormat {
                    codec_name: "hevc".into(),
                    width: 1920,
                    height: 1080,
                    r_frame_rate: "30/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
                PreviewClipFormat {
                    codec_name: "h264".into(),
                    width: 1920,
                    height: 1080,
                    r_frame_rate: "30/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
            ],
        };
        assert_eq!(resolve_auto_target_codec(&info, "h264"), "h265");
    }

    #[test]
    fn all_clips_match() {
        let info = PreviewFormatInfo {
            compatible: false,
            details: String::new(),
            formats: vec![
                h264_1080p30(),
                PreviewClipFormat {
                    codec_name: "h264".into(),
                    width: 1920,
                    height: 1080,
                    r_frame_rate: "30000/1001".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
            ],
        };
        assert!(all_clips_match_preview_target(&info));
    }

    #[test]
    fn encoding_plan_stream_copy_when_matching() {
        let info = PreviewFormatInfo {
            compatible: true,
            details: String::new(),
            formats: vec![h264_1080p30()],
        };
        let plan = resolve_encoding_plan("auto", "per_clip", &info, false);
        assert_eq!(plan.strategy, PreviewStrategy::StreamCopyOnly);
        assert!(!plan.needs_clip_reencoding);
    }

    #[test]
    fn encoding_plan_force_codec_combined() {
        let info = PreviewFormatInfo {
            compatible: true,
            details: String::new(),
            formats: vec![PreviewClipFormat {
                codec_name: "h264".into(),
                width: 3840,
                height: 2160,
                r_frame_rate: "60/1".into(),
                pix_fmt: "yuv420p".into(),
                error: None,
            }],
        };
        let plan = resolve_encoding_plan("h265", "combined", &info, false);
        assert_eq!(plan.strategy, PreviewStrategy::Combined);
        assert!(plan.needs_combined_reencoding);
        assert_eq!(plan.target_codec.as_deref(), Some("h265"));
        assert!(
            plan.reencode_reason
                .as_deref()
                .is_some_and(|r| r.contains("kombiniert") || r.contains("Ziel-Codec")),
            "expected combined/codec reason, got {:?}",
            plan.reencode_reason
        );
    }

    #[test]
    fn encoding_plan_incompatible_auto_per_clip() {
        let info = PreviewFormatInfo {
            compatible: false,
            details: "mixed".into(),
            formats: vec![
                PreviewClipFormat {
                    codec_name: "h264".into(),
                    width: 3840,
                    height: 2160,
                    r_frame_rate: "60/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
                PreviewClipFormat {
                    codec_name: "hevc".into(),
                    width: 1920,
                    height: 1080,
                    r_frame_rate: "30/1".into(),
                    pix_fmt: "yuv420p".into(),
                    error: None,
                },
            ],
        };
        let plan = resolve_encoding_plan("auto", "per_clip", &info, false);
        assert_eq!(plan.strategy, PreviewStrategy::PerClip);
        assert!(plan.needs_clip_reencoding);
        assert_eq!(plan.target_codec.as_deref(), Some("h264"));
        assert_eq!(plan.reencode_reason.as_deref(), Some("mixed"));
    }

    #[test]
    fn encoding_plan_reencode_matching_clips_sets_reason() {
        let info = PreviewFormatInfo {
            compatible: true,
            details: String::new(),
            formats: vec![PreviewClipFormat {
                codec_name: "h264".into(),
                width: 3840,
                height: 2160,
                r_frame_rate: "60/1".into(),
                pix_fmt: "yuv420p".into(),
                error: None,
            }],
        };
        let plan = resolve_encoding_plan("h264", "per_clip", &info, true);
        assert!(plan.needs_clip_reencoding);
        assert!(
            plan.reencode_reason
                .as_deref()
                .is_some_and(|r| r.contains("Passende Clips neu encodieren")),
            "got {:?}",
            plan.reencode_reason
        );
    }

    #[test]
    fn build_preview_reencode_args_structure() {
        let hw = HwAccelInfo::software();
        let fmt = h264_1080p30();
        // Already 1080p@30 → no vf needed for matching clip, but wrong codec forces encode
        let mut src = fmt.clone();
        src.width = 3840;
        src.height = 2160;
        let args = build_preview_reencode_args(
            "in.mp4",
            "out.mp4",
            "h264",
            Some(&src),
            &hw,
            false,
            18,
        );
        assert!(args.contains(&"-y".to_string()));
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"in.mp4".to_string()));
        assert!(args.contains(&"-c:v".to_string()));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"18".to_string()));
        assert!(args.contains(&"-vf".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("out.mp4"));
        assert!(args.iter().any(|a| a.contains("scale=1920:1080")));
    }

    #[test]
    fn build_preview_skips_vf_when_already_target() {
        let hw = HwAccelInfo::software();
        let args = build_preview_reencode_args(
            "in.mp4",
            "out.mp4",
            "h264",
            Some(&h264_1080p30()),
            &hw,
            false,
            23,
        );
        assert!(!args.iter().any(|a| a == "-vf"));
        assert!(args.contains(&"23".to_string()));
    }

    #[test]
    fn clip_needs_filter_for_4k() {
        let fmt = PreviewClipFormat {
            codec_name: "h264".into(),
            width: 3840,
            height: 2160,
            r_frame_rate: "30/1".into(),
            pix_fmt: "yuv420p".into(),
            error: None,
        };
        assert!(clip_needs_video_filter(Some(&fmt)));
        assert!(!clip_needs_video_filter(Some(&h264_1080p30())));
    }

    #[test]
    fn nvidia_preview_args_use_nvenc() {
        let hw = HwAccelInfo::nvidia();
        let mut src = h264_1080p30();
        src.width = 1280;
        src.height = 720;
        let args =
            build_preview_reencode_args("in.mp4", "out.mp4", "h264", Some(&src), &hw, true, 18);
        assert!(args.contains(&"h264_nvenc".to_string()));
        assert!(args.contains(&"-cq".to_string()));
    }
}
