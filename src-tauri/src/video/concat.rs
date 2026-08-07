//! Concat / trim / remux helpers (behaviour port of legacy `concat_utils.py`).
//!
//! Stream-copy where codecs match; HEVC/H.264 splice via MPEG-TS or MKV remux.
//! Re-encode fallback when stream-copy is not viable.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use once_cell::sync::Lazy;
use serde::Serialize;
use thiserror::Error;

use super::ffmpeg::{
    disk_full_error, ffmpeg_probe_stderr, indicates_disk_full, is_cancelled, is_disk_full_error,
    probe_duration_secs, run_ffmpeg, run_ffmpeg_capture_stderr, run_ffmpeg_checked, FfmpegError,
    ProgressCallback,
};
use super::hw_accel::{detect_hardware, EncodingParams};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::progress::{progress_from_times_with_task, EncodeProgress};

static VIDEO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Video:\s+(\w+)").unwrap()
});
static AUDIO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Audio:").unwrap()
});
static SHOWINFO_TYPE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)pts_time:([0-9]+(?:\.[0-9]+)?).*?\btype:\s*([IPB])\b").unwrap()
});

#[derive(Debug, Error)]
pub enum ConcatError {
    #[error(transparent)]
    Ffmpeg(#[from] FfmpegError),
    #[error(transparent)]
    Parallel(#[from] ParallelError),
    /// Stream-copy is not possible; caller may ask the user before re-encoding.
    #[error("stream-copy nicht möglich: {reason}")]
    NeedsReencode { reason: String },
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn concat_error_is_disk_full(err: &ConcatError) -> bool {
    match err {
        ConcatError::Ffmpeg(e) => is_disk_full_error(e),
        ConcatError::Io(e) if e.kind() == std::io::ErrorKind::StorageFull => true,
        ConcatError::Message(m) => indicates_disk_full(m),
        ConcatError::NeedsReencode { reason } => indicates_disk_full(reason),
        other => indicates_disk_full(&other.to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
    Other,
}

impl VideoCodec {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264",
            VideoCodec::Hevc => "hevc",
            VideoCodec::Other => "other",
        }
    }
}

/// Normalize codec name like legacy `normalize_vcodec_name`.
pub fn normalize_vcodec_name(codec_name: &str) -> VideoCodec {
    let name = codec_name.trim().to_lowercase();
    if name.is_empty() {
        return VideoCodec::H264;
    }
    match name.as_str() {
        "hevc" | "h265" | "hev1" | "hvc1" => VideoCodec::Hevc,
        "h264" | "avc" | "avc1" => VideoCodec::H264,
        _ => VideoCodec::Other,
    }
}

/// hev1 = in-band parameter sets — more robust for concat than hvc1.
pub fn hevc_stream_copy_video_tag() -> &'static str {
    "hev1"
}

// ---------------------------------------------------------------------------
// Pure FFmpeg command builders (unit-tested)
// ---------------------------------------------------------------------------

fn map_audio_if(has_audio: bool, args: &mut Vec<String>) {
    if has_audio {
        args.extend(["-map".into(), "0:a:0".into()]);
    }
}

/// Remux with clean timestamps (stream-copy).
pub fn build_normalize_mp4_args(input: &str, output: &str, has_audio: bool) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string(),
    ]);
    args
}

/// HEVC MP4 prep for splice: insert AUD, force hev1 tag.
pub fn build_prep_hevc_splice_args(
    input: &str,
    output: &str,
    has_audio: bool,
    video_tag: &str,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-bsf:v".into(),
        "hevc_metadata=aud=insert".into(),
        "-tag:v".into(),
        video_tag.to_string(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string(),
    ]);
    args
}

/// Stream-copy trim from a keyframe timestamp (`-ss` before `-i`).
pub fn build_trim_start_to_keyframe_args(
    input: &str,
    output: &str,
    keyframe_secs: f64,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-ss".into(),
        format_secs(keyframe_secs),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-copyinkf".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string(),
    ]);
    args
}

/// Trim `[start, end)` via stream-copy (keyframe-aligned seek).
pub fn build_trim_video_copy_args(
    input: &str,
    output: &str,
    start_secs: f64,
    end_secs: f64,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-ss".into(),
        format_secs(start_secs),
        "-to".into(),
        format_secs(end_secs),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Precise trim via re-encode (when stream-copy is insufficient).
pub fn build_trim_video_reencode_args(
    input: &str,
    output: &str,
    start_secs: f64,
    end_secs: f64,
    params: &EncodingParams,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());
    args.push("-hide_banner".into());
    args.extend(params.input_params.iter().cloned());
    args.push("-ss".into());
    args.push(format_secs(start_secs));
    args.push("-to".into());
    args.push(format_secs(end_secs));
    args.push("-i".into());
    args.push(input.to_string());
    args.extend(params.output_params.iter().cloned());
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
    args
}

/// Concat demuxer → MKV (stream-copy), Avidemux-style intermediate.
pub fn build_concat_mp4_to_mkv_args(concat_list_path: &str, output_mkv: &str) -> Vec<String> {
    vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        concat_list_path.to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        output_mkv.to_string(),
    ]
}

/// MKV → MP4 stream-copy with fresh container index + AUD insert.
pub fn build_remux_mkv_to_mp4_args(
    input_mkv: &str,
    output_mp4: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    video_tag: &str,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input_mkv.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-max_interleave_delta".into(),
        "0".into(),
    ]);
    match vcodec {
        VideoCodec::Hevc => {
            args.extend([
                "-bsf:v".into(),
                "hevc_metadata=aud=insert".into(),
                "-tag:v".into(),
                video_tag.to_string(),
            ]);
        }
        VideoCodec::H264 => {
            args.extend([
                "-bsf:v".into(),
                "h264_metadata=aud=insert".into(),
                "-tag:v".into(),
                "avc1".into(),
            ]);
        }
        VideoCodec::Other => {}
    }
    if has_audio {
        args.extend(["-bsf:a".into(), "aac_adtstoasc".into()]);
    }
    args.push(output_mp4.to_string());
    args
}

/// MP4 → MPEG-TS stream-copy (Annex-B) for robust concat.
pub fn build_mp4_to_mpegts_args(
    input: &str,
    output_ts: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
    ]);
    match vcodec {
        VideoCodec::H264 => {
            args.extend(["-bsf:v".into(), "h264_mp4toannexb".into()]);
        }
        VideoCodec::Hevc => {
            args.extend(["-bsf:v".into(), "hevc_mp4toannexb".into()]);
        }
        VideoCodec::Other => {}
    }
    args.extend(["-f".into(), "mpegts".into(), output_ts.to_string()]);
    args
}

/// MPEG-TS streams → single MP4 (stream-copy, no reset_timestamps).
pub fn build_mpegts_concat_to_mp4_args(
    output_mp4: &str,
    ts_paths: &[String],
    vcodec: VideoCodec,
    has_audio: bool,
    video_tag: &str,
) -> Vec<String> {
    let concat_input = format!("concat:{}", ts_paths.join("|"));
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        concat_input,
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-max_interleave_delta".into(),
        "0".into(),
    ]);
    if has_audio {
        args.extend(["-bsf:a".into(), "aac_adtstoasc".into()]);
    }
    args.extend(["-movflags".into(), "+faststart".into()]);
    match vcodec {
        VideoCodec::Hevc => {
            args.extend([
                "-bsf:v".into(),
                "hevc_metadata=aud=insert".into(),
                "-tag:v".into(),
                video_tag.to_string(),
            ]);
        }
        VideoCodec::H264 => {
            args.extend([
                "-bsf:v".into(),
                "h264_metadata=aud=insert".into(),
                "-tag:v".into(),
                "avc1".into(),
            ]);
        }
        VideoCodec::Other => {}
    }
    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_mp4.to_string(),
    ]);
    args
}

/// Concat demuxer stream-copy (simple same-codec MP4 list).
#[allow(dead_code)] // public builder for Phase 3 / alternate concat path
pub fn build_concat_demuxer_copy_args(
    concat_list_path: &str,
    output: &str,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        concat_list_path.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    if has_audio {
        args.extend(["-map".into(), "0:a:0?".into()]);
    }
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Re-encode concat via demuxer (fallback when stream-copy fails / codecs differ).
pub fn build_concat_demuxer_reencode_args(
    concat_list_path: &str,
    output: &str,
    params: &EncodingParams,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());
    args.push("-hide_banner".into());
    args.extend(params.input_params.iter().cloned());
    args.extend([
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        concat_list_path.to_string(),
    ]);
    args.extend(params.output_params.iter().cloned());
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
    args
}

/// Short decode around a splice point to detect broken stream-copy.
pub fn build_validate_splice_decode_args(
    output_path: &str,
    intro_duration_sec: f64,
    scan_sec: f64,
) -> Vec<String> {
    let seek = (intro_duration_sec - 0.25).max(0.0);
    vec![
        "-v".into(),
        "error".into(),
        "-nostats".into(),
        "-ss".into(),
        format_secs(seek),
        "-i".into(),
        output_path.to_string(),
        "-t".into(),
        format_secs(scan_sec),
        "-map".into(),
        "0:v:0".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// Keyframe scan via `showinfo` (no ffprobe required).
pub fn build_keyframe_scan_args(input: &str, max_scan_sec: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-t".into(),
        format_secs(max_scan_sec),
        "-vf".into(),
        "select=eq(pict_type\\,I),showinfo".into(),
        "-vsync".into(),
        "vfr".into(),
        "-an".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

pub fn write_concat_file_list(segment_paths: &[&str], list_path: &Path) -> Result<(), ConcatError> {
    let mut body = String::new();
    for segment in segment_paths {
        let abs = Path::new(segment)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(segment));
        let escaped = abs.to_string_lossy().replace('\\', "/");
        body.push_str(&format!("file '{escaped}'\n"));
    }
    if let Some(parent) = list_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(list_path, body)?;
    Ok(())
}

fn format_secs(secs: f64) -> String {
    // Keep enough precision for keyframe seeks without scientific notation.
    format!("{secs:.6}")
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

pub fn probe_vcodec(ffmpeg: &Path, input: &str) -> Result<VideoCodec, ConcatError> {
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    parse_vcodec_from_probe(&stderr)
        .ok_or_else(|| ConcatError::Message(format!("no video stream in: {input}")))
}

pub fn probe_has_audio(ffmpeg: &Path, input: &str) -> Result<bool, ConcatError> {
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    Ok(AUDIO_STREAM_RE.is_match(&stderr))
}

pub fn parse_vcodec_from_probe(stderr: &str) -> Option<VideoCodec> {
    let caps = VIDEO_STREAM_RE.captures(stderr)?;
    Some(normalize_vcodec_name(caps.get(1)?.as_str()))
}

/// Parse first I-frame `pts_time` from ffmpeg `showinfo` stderr.
pub fn parse_first_keyframe_time(stderr: &str) -> Option<f64> {
    for caps in SHOWINFO_TYPE_RE.captures_iter(stderr) {
        let pict = caps.get(2)?.as_str().to_uppercase();
        if pict != "I" {
            continue;
        }
        if let Ok(t) = caps.get(1)?.as_str().parse::<f64>() {
            return Some(t);
        }
    }
    None
}

pub fn body_starts_with_keyframe(ffmpeg: &Path, video_path: &str) -> bool {
    match get_first_keyframe_time(ffmpeg, video_path, 1.0) {
        Some(t) => t <= 0.05,
        None => false,
    }
}

pub fn get_first_keyframe_time(
    ffmpeg: &Path,
    video_path: &str,
    max_scan_sec: f64,
) -> Option<f64> {
    let args = build_keyframe_scan_args(video_path, max_scan_sec);
    let (_code, stderr) = run_ffmpeg_capture_stderr(ffmpeg, &args).ok()?;
    parse_first_keyframe_time(&stderr)
}

pub fn validate_splice_decode(
    ffmpeg: &Path,
    output_path: &str,
    intro_duration_sec: f64,
    scan_sec: f64,
) -> (bool, String) {
    let args = build_validate_splice_decode_args(output_path, intro_duration_sec, scan_sec);
    match run_ffmpeg_capture_stderr(ffmpeg, &args) {
        Ok((0, _)) => (true, String::new()),
        Ok((_, err)) => {
            let msg = err.trim();
            (
                false,
                if msg.is_empty() {
                    "Decode an Nahtstelle fehlgeschlagen".into()
                } else {
                    msg.to_string()
                },
            )
        }
        Err(e) => (false, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

fn make_work_dir(prefix: &str) -> Result<PathBuf, ConcatError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ats_{prefix}_{}_{millis}", std::process::id()));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn emit(on_progress: &ProgressCallback, percent: f64, status: &str) {
    on_progress(EncodeProgress {
        percent: percent.clamp(0.0, 100.0),
        current_secs: 0.0,
        total_secs: 0.0,
        status: status.to_string(),
        task_id: None,
    });
}

/// Ensure body starts on a keyframe (stream-copy). Returns path to use.
pub fn trim_body_start_to_keyframe(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &str,
    has_audio: bool,
) -> Result<String, ConcatError> {
    if body_starts_with_keyframe(ffmpeg, input_path) {
        let in_norm = Path::new(input_path);
        let out_norm = Path::new(output_path);
        if in_norm == out_norm {
            return Ok(input_path.to_string());
        }
        let args = build_normalize_mp4_args(input_path, output_path, has_audio);
        run_ffmpeg_checked(ffmpeg, &args)?;
        return Ok(output_path.to_string());
    }

    let kf_time = get_first_keyframe_time(ffmpeg, input_path, 10.0);
    if kf_time.is_none() || kf_time.unwrap_or(0.0) <= 0.0 {
        let args = build_normalize_mp4_args(input_path, output_path, has_audio);
        run_ffmpeg_checked(ffmpeg, &args)?;
        return Ok(output_path.to_string());
    }

    let args =
        build_trim_start_to_keyframe_args(input_path, output_path, kf_time.unwrap(), has_audio);
    run_ffmpeg_checked(ffmpeg, &args)?;
    Ok(output_path.to_string())
}

/// Result of a successful concat.
#[derive(Debug, Clone, Serialize)]
pub struct ConcatOutcome {
    pub method: String,
    pub codec: String,
    /// Set when `method` is `re-encode`.
    pub reencode_reason: Option<String>,
}

/// Probe inputs and attempt stream-copy concat only (no re-encode fallback).
///
/// Returns [`ConcatError::NeedsReencode`] when codecs differ or stream-copy fails
/// (disk-full / cancel remain fatal errors).
pub fn concat_videos_stream_copy_only(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    on_progress: ProgressCallback,
) -> Result<ConcatOutcome, ConcatError> {
    if paths.len() < 2 {
        return Err(ConcatError::Message(
            "concat_videos requires at least 2 input paths".into(),
        ));
    }
    for p in paths {
        if !Path::new(p).is_file() {
            return Err(ConcatError::Message(format!("input file not found: {p}")));
        }
    }

    emit(&on_progress, 2.0, "probing");

    let mut codecs = Vec::with_capacity(paths.len());
    let mut has_audio_flags = Vec::with_capacity(paths.len());
    let mut total_secs = 0.0_f64;
    for p in paths {
        codecs.push(probe_vcodec(ffmpeg, p)?);
        has_audio_flags.push(probe_has_audio(ffmpeg, p)?);
        total_secs += probe_duration_secs(ffmpeg, p).unwrap_or(0.0);
    }

    let all_same = codecs.windows(2).all(|w| w[0] == w[1]);
    let vcodec = codecs[0];
    let has_audio = has_audio_flags.iter().all(|&a| a);
    let stream_copy_ok =
        all_same && matches!(vcodec, VideoCodec::H264 | VideoCodec::Hevc);

    if stream_copy_ok {
        match concat_stream_copy(ffmpeg, paths, output, vcodec, has_audio, total_secs, &on_progress)
        {
            Ok(()) => {
                emit(&on_progress, 100.0, "end");
                return Ok(ConcatOutcome {
                    method: "stream-copy".into(),
                    codec: vcodec.as_str().into(),
                    reencode_reason: None,
                });
            }
            Err(e) => {
                if concat_error_is_disk_full(&e) {
                    return Err(ConcatError::Ffmpeg(disk_full_error()));
                }
                if matches!(&e, ConcatError::Ffmpeg(FfmpegError::Cancelled)) {
                    return Err(e);
                }
                let _ = fs::remove_file(output);
                let reason = format!("Stream-Copy fehlgeschlagen: {e}");
                return Err(ConcatError::NeedsReencode { reason });
            }
        }
    }

    let reason = if !all_same {
        let names: Vec<&str> = codecs.iter().map(|c| c.as_str()).collect();
        format!(
            "Unterschiedliche Video-Codecs ({})",
            names.join(", ")
        )
    } else {
        format!(
            "Codec „{}“ ist nicht stream-copy-fähig (nur H.264/HEVC)",
            vcodec.as_str()
        )
    };
    Err(ConcatError::NeedsReencode { reason })
}

/// Re-encode concat via demuxer (public for intro-mux fallback after user consent).
pub fn concat_videos_reencode(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    reason: &str,
    on_progress: ProgressCallback,
) -> Result<ConcatOutcome, ConcatError> {
    if paths.len() < 2 {
        return Err(ConcatError::Message(
            "concat_videos requires at least 2 input paths".into(),
        ));
    }
    let mut total_secs = 0.0_f64;
    let mut codecs = Vec::with_capacity(paths.len());
    for p in paths {
        if !Path::new(p).is_file() {
            return Err(ConcatError::Message(format!("input file not found: {p}")));
        }
        codecs.push(probe_vcodec(ffmpeg, p)?);
        total_secs += probe_duration_secs(ffmpeg, p).unwrap_or(0.0);
    }
    let vcodec = codecs[0];
    concat_reencode(ffmpeg, paths, output, total_secs, reason, &on_progress)?;
    emit(&on_progress, 100.0, "end");
    Ok(ConcatOutcome {
        method: "re-encode".into(),
        codec: vcodec.as_str().into(),
        reencode_reason: Some(reason.to_string()),
    })
}

/// Concatenate multiple videos into one MP4.
///
/// Prefers MPEG-TS stream-copy (H.264/HEVC). Falls back to re-encode when
/// codecs differ or stream-copy fails.
pub fn concat_videos(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    on_progress: ProgressCallback,
) -> Result<ConcatOutcome, ConcatError> {
    match concat_videos_stream_copy_only(ffmpeg, paths, output, Arc::clone(&on_progress)) {
        Ok(outcome) => Ok(outcome),
        Err(ConcatError::NeedsReencode { reason }) => {
            emit(
                &on_progress,
                40.0,
                &format!("Kodiere neu: {reason}"),
            );
            concat_videos_reencode(ffmpeg, paths, output, &reason, on_progress)
        }
        Err(e) => Err(e),
    }
}

fn concat_stream_copy(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    let work = make_work_dir("concat")?;
    let video_tag = hevc_stream_copy_video_tag();
    let n = paths.len();

    // Parallel prep of each segment (normalize / HEVC splice / MPEG-TS).
    let hw = detect_hardware();
    let pool = ParallelVideoProcessor::new(hw.available);
    let ffmpeg_path = ffmpeg.to_path_buf();
    let paths_owned: Vec<String> = paths.to_vec();
    let work_dir = work.clone();
    let progress = on_progress.clone();

    let prep_results = pool.process_indexed(
        n,
        |i, task_id| -> Result<(PathBuf, String), ConcatError> {
            if is_cancelled() {
                return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
            }
            let activity = format!("Clip {task_id}/{n}: Segment vorbereiten…");
            let mid = format!("Clip {task_id}/{n}: Segment normalisieren…");
            let done = format!("Clip {task_id}/{n}: Segment bereit");
            progress(progress_from_times_with_task(0.0, 100.0, &activity, Some(task_id)));

            let mut current = paths_owned[i].clone();

            if vcodec == VideoCodec::Hevc && i > 0 {
                let kf_out = work_dir.join(format!("seg_{i}_kf.mp4"));
                trim_body_start_to_keyframe(
                    &ffmpeg_path,
                    &current,
                    &path_str(&kf_out),
                    has_audio,
                )?;
                current = path_str(&kf_out);
            }

            let norm = work_dir.join(format!("seg_{i}_norm.mp4"));
            let norm_args = build_normalize_mp4_args(&current, &path_str(&norm), has_audio);
            run_ffmpeg_checked(&ffmpeg_path, &norm_args)?;
            current = path_str(&norm);

            progress(progress_from_times_with_task(50.0, 100.0, &mid, Some(task_id)));

            if vcodec == VideoCodec::Hevc {
                let splice = work_dir.join(format!("seg_{i}_splice.mp4"));
                let args =
                    build_prep_hevc_splice_args(&current, &path_str(&splice), has_audio, video_tag);
                run_ffmpeg_checked(&ffmpeg_path, &args)?;
                current = path_str(&splice);
            }

            let ts = work_dir.join(format!("seg_{i}.ts"));
            let ts_args = build_mp4_to_mpegts_args(&current, &path_str(&ts), vcodec, has_audio);
            run_ffmpeg_checked(&ffmpeg_path, &ts_args)?;

            progress(progress_from_times_with_task(100.0, 100.0, &done, Some(task_id)));
            Ok((PathBuf::from(&current), path_str(&ts)))
        },
        None,
    )?;

    let mut prepared: Vec<PathBuf> = Vec::with_capacity(n);
    let mut ts_paths: Vec<String> = Vec::with_capacity(n);
    for result in prep_results {
        let (prepared_path, ts_path) = result?;
        prepared.push(prepared_path);
        ts_paths.push(ts_path);
    }

    emit(on_progress, 70.0, "mpegts-concat");

    let concat_args =
        build_mpegts_concat_to_mp4_args(output, &ts_paths, vcodec, has_audio, video_tag);

    // Prefer progress-aware run for the final mux
    let result = run_ffmpeg(ffmpeg, &concat_args, total_secs, on_progress.clone());

    if let Err(ref e) = result {
        if is_disk_full_error(e) {
            return Err(ConcatError::Ffmpeg(disk_full_error()));
        }
    }

    if result.is_err() && vcodec == VideoCodec::Hevc {
        // HEVC fallback: MKV remux path (legacy Avidemux-style)
        emit(on_progress, 75.0, "hevc-mkv-fallback");
        let list_path = work.join("concat_list.txt");
        let prepared_strs: Vec<String> = prepared.iter().map(|p| path_str(p)).collect();
        let refs: Vec<&str> = prepared_strs.iter().map(|s| s.as_str()).collect();
        write_concat_file_list(&refs, &list_path)?;

        let mkv = work.join("splice_concat.mkv");
        let mkv_args = build_concat_mp4_to_mkv_args(&path_str(&list_path), &path_str(&mkv));
        match run_ffmpeg_checked(ffmpeg, &mkv_args) {
            Err(e) if is_disk_full_error(&e) => {
                return Err(ConcatError::Ffmpeg(disk_full_error()));
            }
            Err(e) => return Err(ConcatError::Ffmpeg(e)),
            Ok(()) => {}
        }

        let remux_args = build_remux_mkv_to_mp4_args(
            &path_str(&mkv),
            output,
            VideoCodec::Hevc,
            has_audio,
            video_tag,
        );
        match run_ffmpeg_checked(ffmpeg, &remux_args) {
            Err(e) if is_disk_full_error(&e) => {
                return Err(ConcatError::Ffmpeg(disk_full_error()));
            }
            Err(e) => return Err(ConcatError::Ffmpeg(e)),
            Ok(()) => {}
        }
    } else {
        result?;
    }

    // Optional splice validation around first segment boundary
    if let Ok(intro_dur) = probe_duration_secs(ffmpeg, &paths[0]) {
        let (ok, reason) = validate_splice_decode(ffmpeg, output, intro_dur, 2.0);
        if !ok {
            let _ = fs::remove_file(output);
            return Err(ConcatError::Message(format!(
                "splice validation failed: {reason}"
            )));
        }
    }

    let _ = fs::remove_dir_all(&work);
    Ok(())
}

fn concat_reencode(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    total_secs: f64,
    reason: &str,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    // Keep the reason visible for the whole re-encode stage (do not emit bare "re-encode").
    emit(
        on_progress,
        50.0,
        &format!("Kodiere neu: {reason}"),
    );
    let work = make_work_dir("concat_re")?;
    let list_path = work.join("concat_list.txt");
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&refs, &list_path)?;

    let hw = detect_hardware();
    let params = EncodingParams::from_hw(&hw, false);
    let args = build_concat_demuxer_reencode_args(&path_str(&list_path), output, &params);

    run_ffmpeg(ffmpeg, &args, total_secs, on_progress.clone())?;
    let _ = fs::remove_dir_all(&work);
    Ok(())
}

/// Trim video to `[start_secs, end_secs)`.
///
/// Default: stream-copy (keyframe-aligned). Set `precise=true` for re-encode.
pub fn trim_video(
    ffmpeg: &Path,
    input: &str,
    start_secs: f64,
    end_secs: f64,
    output: &str,
    precise: bool,
    on_progress: ProgressCallback,
) -> Result<(), ConcatError> {
    if !Path::new(input).is_file() {
        return Err(ConcatError::Message(format!(
            "input file not found: {input}"
        )));
    }
    if !(start_secs >= 0.0) || !(end_secs > start_secs) {
        return Err(ConcatError::Message(
            "trim requires 0 <= start < end".into(),
        ));
    }

    let duration = end_secs - start_secs;
    let has_audio = probe_has_audio(ffmpeg, input).unwrap_or(true);

    if precise {
        emit(
            &on_progress,
            5.0,
            "Kodiere neu: Präziser Zuschnitt (frame-genau) erfordert Neu-Kodierung",
        );
        let hw = detect_hardware();
        let params = EncodingParams::from_hw(&hw, false);
        let args = build_trim_video_reencode_args(input, output, start_secs, end_secs, &params);
        run_ffmpeg(ffmpeg, &args, duration, on_progress)?;
    } else {
        emit(&on_progress, 5.0, "stream-copy trim");
        let args = build_trim_video_copy_args(input, output, start_secs, end_secs, has_audio);
        run_ffmpeg(ffmpeg, &args, duration, on_progress)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::hw_accel::EncodingParams;

    #[test]
    fn normalize_vcodec_hevc_aliases() {
        assert_eq!(normalize_vcodec_name("hevc"), VideoCodec::Hevc);
        assert_eq!(normalize_vcodec_name("H265"), VideoCodec::Hevc);
        assert_eq!(normalize_vcodec_name("hvc1"), VideoCodec::Hevc);
        assert_eq!(normalize_vcodec_name("h264"), VideoCodec::H264);
        assert_eq!(normalize_vcodec_name("avc1"), VideoCodec::H264);
        assert_eq!(normalize_vcodec_name(""), VideoCodec::H264);
        assert_eq!(normalize_vcodec_name("vp9"), VideoCodec::Other);
    }

    #[test]
    fn parse_vcodec_from_ffmpeg_banner() {
        let hevc = "  Stream #0:0(eng): Video: hevc (Main), yuv420p, 1920x1080";
        assert_eq!(parse_vcodec_from_probe(hevc), Some(VideoCodec::Hevc));
        let h264 = "  Stream #0:0: Video: h264 (High), yuv420p, 1280x720";
        assert_eq!(parse_vcodec_from_probe(h264), Some(VideoCodec::H264));
        let modern = "  Stream #0:0[0x1](und): Video: h264 (Baseline), yuv420p, 832x464";
        assert_eq!(parse_vcodec_from_probe(modern), Some(VideoCodec::H264));
    }

    #[test]
    fn parse_keyframe_showinfo() {
        let stderr = r#"
[Parsed_showinfo_0 @ 0x1] n:   0 pts:      0 pts_time:0.000000 pos:     48 fmt:yuv420p sar:0/1 s:1920x1080 i:P type:I checksum:...
[Parsed_showinfo_0 @ 0x1] n:  30 pts:   1024 pts_time:1.000000 type:P
"#;
        assert!((parse_first_keyframe_time(stderr).unwrap() - 0.0).abs() < 0.001);

        let later = r#"n:  12 pts:  500 pts_time:0.400000 type:I checksum:x"#;
        assert!((parse_first_keyframe_time(later).unwrap() - 0.4).abs() < 0.001);
    }

    #[test]
    fn normalize_mp4_args_with_and_without_audio() {
        let with_a = build_normalize_mp4_args("in.mp4", "out.mp4", true);
        assert!(with_a.contains(&"0:a:0".into()));
        assert!(with_a.contains(&"+faststart".into()));
        assert!(with_a.contains(&"copy".into()));

        let no_a = build_normalize_mp4_args("in.mp4", "out.mp4", false);
        assert!(!no_a.iter().any(|a| a == "0:a:0"));
    }

    #[test]
    fn prep_hevc_splice_inserts_aud_and_tag() {
        let args = build_prep_hevc_splice_args("a.mp4", "b.mp4", true, "hev1");
        assert!(args.contains(&"hevc_metadata=aud=insert".into()));
        assert!(args.contains(&"-tag:v".into()));
        assert!(args.contains(&"hev1".into()));
    }

    #[test]
    fn trim_to_keyframe_uses_ss_before_i() {
        let args = build_trim_start_to_keyframe_args("in.mp4", "out.mp4", 1.5, true);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i);
        assert!(args.contains(&"1.500000".into()));
        assert!(args.contains(&"-copyinkf".into()));
    }

    #[test]
    fn trim_video_copy_args_order() {
        let args = build_trim_video_copy_args("in.mp4", "out.mp4", 2.0, 8.5, true);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let to = args.iter().position(|a| a == "-to").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < to && to < i);
        assert!(args.contains(&"copy".into()));
        assert!(args.contains(&"pipe:1".into()));
    }

    #[test]
    fn trim_video_reencode_args_include_encoder() {
        let params = EncodingParams::software();
        let args = build_trim_video_reencode_args("in.mp4", "out.mp4", 1.0, 3.0, &params);
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"aac".into()));
        assert!(args.contains(&"-ss".into()));
        assert!(args.contains(&"-to".into()));
    }

    #[test]
    fn concat_mp4_to_mkv_uses_concat_demuxer() {
        let args = build_concat_mp4_to_mkv_args("list.txt", "out.mkv");
        assert!(args.contains(&"concat".into()));
        assert!(args.contains(&"0:a:0?".into()));
        assert_eq!(args.last().unwrap(), "out.mkv");
    }

    #[test]
    fn remux_mkv_hevc_and_h264_bsf() {
        let hevc = build_remux_mkv_to_mp4_args("a.mkv", "a.mp4", VideoCodec::Hevc, true, "hev1");
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"aac_adtstoasc".into()));

        let h264 = build_remux_mkv_to_mp4_args("a.mkv", "a.mp4", VideoCodec::H264, false, "hev1");
        assert!(h264.contains(&"h264_metadata=aud=insert".into()));
        assert!(h264.contains(&"avc1".into()));
        assert!(!h264.iter().any(|a| a == "aac_adtstoasc"));
    }

    #[test]
    fn mp4_to_mpegts_annexb() {
        let h264 = build_mp4_to_mpegts_args("a.mp4", "a.ts", VideoCodec::H264, true);
        assert!(h264.contains(&"h264_mp4toannexb".into()));
        assert!(h264.contains(&"mpegts".into()));

        let hevc = build_mp4_to_mpegts_args("a.mp4", "a.ts", VideoCodec::Hevc, false);
        assert!(hevc.contains(&"hevc_mp4toannexb".into()));
        assert!(!hevc.iter().any(|a| a == "0:a:0"));
    }

    #[test]
    fn mpegts_concat_command() {
        let ts = vec!["a.ts".into(), "b.ts".into()];
        let args = build_mpegts_concat_to_mp4_args("out.mp4", &ts, VideoCodec::H264, true, "hev1");
        assert!(args.iter().any(|a| a.starts_with("concat:")));
        assert!(args.contains(&"h264_metadata=aud=insert".into()));
        assert!(args.contains(&"avc1".into()));
        assert!(args.contains(&"aac_adtstoasc".into()));
        assert_eq!(args.last().unwrap(), "out.mp4");

        let hevc =
            build_mpegts_concat_to_mp4_args("out.mp4", &ts, VideoCodec::Hevc, true, "hev1");
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"hev1".into()));
    }

    #[test]
    fn concat_demuxer_copy_and_reencode() {
        let copy = build_concat_demuxer_copy_args("list.txt", "out.mp4", true);
        assert!(copy.contains(&"concat".into()));
        assert!(copy.contains(&"copy".into()));

        let params = EncodingParams::software();
        let re = build_concat_demuxer_reencode_args("list.txt", "out.mp4", &params);
        assert!(re.contains(&"libx264".into()));
        assert!(re.contains(&"aac".into()));
    }

    #[test]
    fn validate_splice_seek_before_seam() {
        let args = build_validate_splice_decode_args("out.mp4", 5.0, 2.0);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "4.750000");
        assert!(args.contains(&"null".into()));
    }

    #[test]
    fn keyframe_scan_filter() {
        let args = build_keyframe_scan_args("in.mp4", 10.0);
        assert!(args.iter().any(|a| a.contains("pict_type")));
        assert!(args.iter().any(|a| a.contains("showinfo")));
    }

    #[test]
    fn write_concat_list_format() {
        let dir = std::env::temp_dir().join("ats_concat_list_test");
        let _ = fs::create_dir_all(&dir);
        let a = dir.join("a.mp4");
        let b = dir.join("b.mp4");
        fs::write(&a, b"x").unwrap();
        fs::write(&b, b"y").unwrap();
        let list = dir.join("list.txt");
        write_concat_file_list(&[&path_str(&a), &path_str(&b)], &list).unwrap();
        let text = fs::read_to_string(&list).unwrap();
        assert!(text.lines().count() >= 2);
        assert!(text.contains("file '"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hevc_tag_default() {
        assert_eq!(hevc_stream_copy_video_tag(), "hev1");
    }
}
