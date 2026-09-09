//! Concat / trim / remux helpers (behaviour port of legacy `concat_utils.py`).
//!
//! Stream-copy where codecs match; HEVC/H.264 splice via MPEG-TS or MKV remux.
//! Re-encode fallback when stream-copy is not viable.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use once_cell::sync::Lazy;
use serde::Serialize;
use thiserror::Error;

use super::body_concat_fallback::{BodyConcatAskFn, BodyConcatChoice};
use super::ffmpeg::{
    disk_full_error, ffmpeg_probe_stderr, indicates_disk_full, is_cancelled, is_disk_full_error,
    probe_duration_secs, run_ffmpeg, run_ffmpeg_capture_stderr, run_ffmpeg_checked, FfmpegError,
    ProgressCallback,
};
use super::hw_accel::{detect_hardware, EncodingParams};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::progress::{progress_from_times_with_task, EncodeProgress};
use super::prep_cache;
use super::probe::CompatibleStreamKey;
use super::probe_cache::{self, CachedClipProbe};
use super::reencode_confirm::{self, ReencodeAskFn, ReencodeIntent, ReencodeKind, ReencodeParams};
use crate::storage::logging;

static VIDEO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Video:\s+(\w+)").unwrap()
});
static AUDIO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Audio:").unwrap()
});
static AUDIO_CODEC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Audio:\s+(\w+).*?(\d+)\s*Hz",
    )
    .unwrap()
});
static SHOWINFO_TYPE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)pts_time:([0-9]+(?:\.[0-9]+)?).*?\btype:\s*([IPB])\b").unwrap()
});
/// Fallback when using `-skip_frame nokey` (every showinfo line is a keyframe).
static SHOWINFO_PTS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)pts_time:([0-9]+(?:\.[0-9]+)?)").unwrap()
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

/// Shell-style command string for log output (paths with spaces quoted).
fn format_ffmpeg_command(ffmpeg: &Path, args: &[String]) -> String {
    let mut parts = vec![ffmpeg.to_string_lossy().into_owned()];
    for arg in args {
        if arg.contains([' ', '\t', '"']) {
            parts.push(format!("\"{}\"", arg.replace('"', "\\\"")));
        } else {
            parts.push(arg.clone());
        }
    }
    parts.join(" ")
}

/// Log why Compatible TS→MP4 concat failed before MKV fallback.
fn log_compatible_merge_failure(pipeline: &str, ffmpeg: &Path, args: &[String], err: &FfmpegError) {
    logging::warn(
        "concat",
        format!(
            "{pipeline}: TS-Concat fehlgeschlagen — MKV-Fallback: {err}\nFFmpeg: {}",
            format_ffmpeg_command(ffmpeg, args)
        ),
    );
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

/// Compatible-path per-clip prep: AUD + QT-safe tag + strip soft-rotation (stream-copy).
///
/// When `ignore_editlist` is true, adds `-ignore_editlist 1` before `-i` (edit-list hygiene).
pub fn build_prep_compatible_args(
    input: &str,
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    ignore_editlist: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
    ];
    if ignore_editlist {
        args.extend(["-ignore_editlist".into(), "1".into()]);
    }
    // `-display_rotation` is an input option and must come before `-i`.
    args.extend([
        "-noautorotate".into(),
        "-display_rotation".into(),
        "0".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ]);
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-metadata".into(),
        "rotate=0".into(),
        "-metadata:s:v:0".into(),
        "rotate=0".into(),
    ]);
    match vcodec {
        VideoCodec::Hevc => {
            args.extend([
                "-bsf:v".into(),
                "hevc_metadata=aud=insert".into(),
                "-tag:v".into(),
                hevc_stream_copy_video_tag().to_string(),
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
    args.push(output.to_string());
    args
}

/// Compatible-path per-clip prep → MPEG-TS in one pass (rotation/editlist + Annex-B).
///
/// AUD/tag are applied once on the TS→MP4 merge ([`build_compatible_mpegts_concat_to_mp4_args`]),
/// matching the proven Legacy split (Phase 43.2/43.4 — no double AUD). Applying
/// `*_metadata=aud` *before* `*_mp4toannexb` on MP4 inputs produced HEVC-TS without
/// usable dimensions (`dimensions not set`).
///
/// Avoids intermediate MP4 I/O; `+faststart` is omitted (only the final merge needs it).
pub fn build_prep_compatible_to_mpegts_args(
    input: &str,
    output_ts: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    ignore_editlist: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
    ];
    if ignore_editlist {
        args.extend(["-ignore_editlist".into(), "1".into()]);
    }
    args.extend([
        "-noautorotate".into(),
        "-display_rotation".into(),
        "0".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ]);
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-metadata".into(),
        "rotate=0".into(),
        "-metadata:s:v:0".into(),
        "rotate=0".into(),
    ]);
    match vcodec {
        VideoCodec::Hevc => {
            args.extend(["-bsf:v".into(), "hevc_mp4toannexb".into()]);
        }
        VideoCodec::H264 => {
            args.extend(["-bsf:v".into(), "h264_mp4toannexb".into()]);
        }
        VideoCodec::Other => {}
    }
    args.extend(["-f".into(), "mpegts".into(), output_ts.to_string()]);
    args
}

/// Compatible-path MP4→MPEG-TS (wrapper around the shared Annex-B builder).
pub fn build_compatible_mp4_to_mpegts_args(
    input: &str,
    output_ts: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> Vec<String> {
    build_mp4_to_mpegts_args(input, output_ts, vcodec, has_audio)
}

/// Compatible-path MPEG-TS→MP4 after TS prep (Phase 43.2 hot-path).
///
/// Same stream-copy merge as Legacy ([`build_mpegts_concat_to_mp4_args`]) including AUD/tag
/// so the MP4 muxer can derive HEVC dimensions; omits only `+faststart` (43.1 finalize).
pub fn build_compatible_mpegts_concat_to_mp4_args(
    concat_list_path: &str,
    output_mp4: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> Vec<String> {
    let mut args = build_mpegts_concat_to_mp4_args(
        concat_list_path,
        output_mp4,
        vcodec,
        has_audio,
        hevc_stream_copy_video_tag(),
    );
    omit_faststart_movflags(&mut args);
    args
}

/// Legacy-style merge on intermediate prep MP4s (kept for tests / non-hot paths).
///
/// Phase 43.2 hot-path uses MPEG-TS prep + [`build_compatible_mpegts_concat_to_mp4_args`].
/// Phase 43.1: omits `+faststart` so join progress is honest 0–100%.
pub fn build_compatible_prep_mp4_concat_args(
    concat_list_path: &str,
    output_mp4: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> Vec<String> {
    let mut args = build_mpegts_concat_to_mp4_args(
        concat_list_path,
        output_mp4,
        vcodec,
        has_audio,
        hevc_stream_copy_video_tag(),
    );
    omit_faststart_movflags(&mut args);
    args
}

/// Remove `-movflags +faststart` pairs (Compatible join vs finalize split, Phase 43.1).
pub fn omit_faststart_movflags(args: &mut Vec<String>) {
    let mut i = 0;
    while i + 1 < args.len() {
        if args[i] == "-movflags" && args[i + 1] == "+faststart" {
            args.remove(i);
            args.remove(i);
            continue;
        }
        i += 1;
    }
}

/// Remove `-bsf:v …aud=insert` pairs when hygiene was already applied earlier
/// (Phase 43.4: single AUD layer — e.g. TS→MP4 remux already inserted AUD before MKV remux).
pub fn omit_video_aud_insert_bsf(args: &mut Vec<String>) {
    let mut i = 0;
    while i + 1 < args.len() {
        if args[i] == "-bsf:v"
            && (args[i + 1] == "h264_metadata=aud=insert"
                || args[i + 1] == "hevc_metadata=aud=insert")
        {
            args.remove(i);
            args.remove(i);
            continue;
        }
        i += 1;
    }
}

/// Worker count for Compatible Dirty remux/prep (CPU stream-copy, not NVENC).
///
/// Independent of `hw.available`: prep is FFmpeg `-c copy`, so coupling to the
/// encode HW pool only capped parallelism oddly on machines without a GPU.
pub fn compatible_remux_prep_worker_count(clip_count: usize) -> usize {
    super::probe::probe_worker_count(clip_count)
}

/// Phase 43.4 splice-validation policy: run only when risk warrants the decode cost.
///
/// - Dirty (TS-prep) path always validates
/// - HEVC always validates (Clean or Dirty)
/// - Clean H.264 skips (Avidemux-like tempo; Gate already matched streams)
///
/// Internal force flag for tests / diagnostics (no UI setting).
pub fn compatible_should_validate_splice(
    dirty: bool,
    vcodec: VideoCodec,
    force: bool,
) -> bool {
    force || dirty || matches!(vcodec, VideoCodec::Hevc)
}

/// Compatible dirty-prep segment filename (MPEG-TS one-pass, Phase 43.2).
pub fn compatible_prep_segment_filename(index: usize) -> String {
    format!("seg_{index}_compat.ts")
}

/// Dispatch: Compatible dirty prep → MPEG-TS args (not intermediate MP4).
pub fn compatible_dirty_prep_plan(
    work_dir: &Path,
    index: usize,
    input: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> (PathBuf, Vec<String>) {
    let out = work_dir.join(compatible_prep_segment_filename(index));
    let args = build_prep_compatible_to_mpegts_args(
        input,
        &path_str(&out),
        vcodec,
        has_audio,
        true,
    );
    (out, args)
}

/// Tag family that Clean-Ein-Pass can handle with output `-tag:v` (Phase 43.3).
///
/// Exotic / encrypted / Dolby tags force Dirty TS-Prep.
pub fn compatible_tag_allows_clean_pass(codec: &str, tag: &str) -> bool {
    let t = tag.trim().to_lowercase();
    match normalize_vcodec_name(codec) {
        VideoCodec::H264 => t.is_empty() || t == "avc1",
        VideoCodec::Hevc => t.is_empty() || t == "hev1" || t == "hvc1",
        VideoCodec::Other => false,
    }
}

/// Clean-Set predicate (Phase 43.3): safe for one-pass concat without per-clip Prep.
///
/// Clean when every clip has:
/// - soft-rotation `Known(0)` (neutral; ≠0 / displaymatrix force Dirty)
/// - QT-safe tag family (no exotic rewrite)
/// - no edit-list hygiene flag
///
/// Empty `keys` → not clean. Gate hard-fails (Unknown/Conflict rotation) run before this.
pub fn compatible_clips_are_clean(keys: &[CompatibleStreamKey]) -> bool {
    if keys.is_empty() {
        return false;
    }
    keys.iter().all(|k| {
        k.rotation.known_degrees() == Some(0)
            && !k.needs_editlist_hygiene
            && compatible_tag_allows_clean_pass(&k.codec, &k.tag)
    })
}

/// Clean-Set: concat demuxer + stream-copy + Compatible output AUD/tag (no Prep, no faststart).
///
/// Analog to [`build_concat_demuxer_copy_args`] plus QT hygiene; finalize applies faststart.
pub fn build_compatible_clean_concat_args(
    concat_list_path: &str,
    output: &str,
    vcodec: VideoCodec,
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
    ]);
    match vcodec {
        VideoCodec::Hevc => {
            args.extend([
                "-bsf:v".into(),
                "hevc_metadata=aud=insert".into(),
                "-tag:v".into(),
                hevc_stream_copy_video_tag().to_string(),
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
        output.to_string(),
    ]);
    args
}

/// Single MPEG-TS segment → MP4 (stream-copy) for Compatible MKV fallback.
///
/// Matroska cannot mux HEVC-from-TS without dimensions; remux to MP4 first
/// (same AUD/tag as the primary merge) so concat→MKV sees a proper track header.
pub fn build_compatible_ts_segment_to_mp4_args(
    input_ts: &str,
    output_mp4: &str,
    vcodec: VideoCodec,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input_ts.to_string(),
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
    match vcodec {
        VideoCodec::Hevc => {
            args.extend([
                "-bsf:v".into(),
                "hevc_metadata=aud=insert".into(),
                "-tag:v".into(),
                hevc_stream_copy_video_tag().to_string(),
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
    args.push(output_mp4.to_string());
    args
}

/// Aggregate Compatible prep progress from completed clip count (0..=100).
pub fn compatible_prep_progress_percent(done: usize, total: usize) -> f64 {
    if total == 0 {
        return 100.0;
    }
    ((done as f64) / (total as f64) * 100.0).clamp(0.0, 100.0)
}

/// Machine status for Compatible prep with visible clip count (`compatible-prep:i/n`).
pub fn compatible_prep_status(done: usize, total: usize) -> String {
    format!("compatible-prep:{done}/{total}")
}

/// Stream-copy remux that only applies `+faststart` (Phase 43.1 finalize pass).
///
/// Maps only video (+ optional audio) — never `-map 0`, so GoPro/DJI timecode
/// / data tracks (`codec none`) are not copied into the output MP4.
pub fn build_compatible_finalize_faststart_args(
    input: &str,
    output: &str,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    map_audio_if(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-dn".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
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

/// MPEG-TS streams → single MP4 (concat demuxer + stream-copy).
pub fn build_mpegts_concat_to_mp4_args(
    concat_list_path: &str,
    output_mp4: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    video_tag: &str,
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
///
/// When `copy_audio` is true, audio is stream-copied (caller must ensure AAC-compatible
/// inputs); otherwise audio is re-encoded to AAC 192k.
pub fn build_concat_demuxer_reencode_args(
    concat_list_path: &str,
    output: &str,
    params: &EncodingParams,
    copy_audio: bool,
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
    if copy_audio {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    }
    args.extend([
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
///
/// Prefer `-skip_frame nokey` so HEVC/IDR packets are found even when
/// `select=eq(pict_type,I)` misses non-IDR I-slices. Avoid deprecated `-vsync`
/// (breaks on newer FFmpeg builds).
pub fn build_keyframe_scan_args(input: &str, max_scan_sec: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-skip_frame".into(),
        "nokey".into(),
        "-i".into(),
        input.to_string(),
        "-t".into(),
        format_secs(max_scan_sec),
        "-vf".into(),
        "showinfo".into(),
        "-an".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// Legacy pict_type filter scan (unit-tested / fallback).
#[allow(dead_code)]
pub fn build_keyframe_scan_args_pict_type(input: &str, max_scan_sec: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-t".into(),
        format_secs(max_scan_sec),
        "-vf".into(),
        "select=eq(pict_type\\,I),showinfo".into(),
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
    if let Some(cached) = probe_cache::get(input) {
        return Ok(normalize_vcodec_name(&cached.codec));
    }
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    let _ = probe_cache::put_from_stderr(input, &stderr);
    parse_vcodec_from_probe(&stderr)
        .ok_or_else(|| ConcatError::Message(format!("no video stream in: {input}")))
}

pub fn probe_has_audio(ffmpeg: &Path, input: &str) -> Result<bool, ConcatError> {
    if let Some(cached) = probe_cache::get(input) {
        return Ok(cached.has_audio);
    }
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    let _ = probe_cache::put_from_stderr(input, &stderr);
    Ok(AUDIO_STREAM_RE.is_match(&stderr))
}

/// Single `ffmpeg -i` probe for Compatible concat (codec, audio, duration, gate key).
#[derive(Debug, Clone)]
pub struct ClipConcatProbe {
    pub vcodec: VideoCodec,
    pub has_audio: bool,
    pub duration_secs: f64,
    pub compatible_key: CompatibleStreamKey,
}

impl ClipConcatProbe {
    pub fn from_cached(cached: &CachedClipProbe) -> Self {
        Self {
            vcodec: normalize_vcodec_name(&cached.codec),
            has_audio: cached.has_audio,
            duration_secs: cached.duration_secs,
            compatible_key: cached.compatible_key.clone(),
        }
    }
}

pub fn probe_clip_for_concat(ffmpeg: &Path, path: &str) -> Result<ClipConcatProbe, ConcatError> {
    if let Some(cached) = probe_cache::get(path) {
        return Ok(ClipConcatProbe::from_cached(&cached));
    }
    let stderr = ffmpeg_probe_stderr(ffmpeg, path).map_err(ConcatError::Ffmpeg)?;
    if parse_vcodec_from_probe(&stderr).is_none() {
        return Err(ConcatError::Message(format!("no video stream in: {path}")));
    }
    let cached = probe_cache::put_from_stderr(path, &stderr).ok_or_else(|| {
        ConcatError::NeedsReencode {
            reason: format!(
                "Compatible Path: Video-Stream nicht lesbar ({})",
                Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path)
            ),
        }
    })?;
    Ok(ClipConcatProbe::from_cached(&cached))
}

/// Returns `(codec, sample_rate_hz)` when an audio stream is present.
pub fn probe_audio_codec(ffmpeg: &Path, input: &str) -> Result<Option<(String, String)>, ConcatError> {
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    Ok(parse_audio_codec_from_probe(&stderr))
}

pub fn parse_audio_codec_from_probe(stderr: &str) -> Option<(String, String)> {
    let caps = AUDIO_CODEC_RE.captures(stderr)?;
    Some((
        caps.get(1)?.as_str().to_ascii_lowercase(),
        caps.get(2)?.as_str().to_string(),
    ))
}

/// True when every input has AAC audio (or all lack audio — then copy is vacuous).
pub fn inputs_allow_aac_audio_copy(ffmpeg: &Path, paths: &[String]) -> bool {
    let mut saw_audio = false;
    let mut sample_rate: Option<String> = None;
    for p in paths {
        match probe_audio_codec(ffmpeg, p) {
            Ok(Some((codec, rate))) => {
                if codec != "aac" && codec != "mp4a" {
                    return false;
                }
                if let Some(ref prev) = sample_rate {
                    if prev != &rate {
                        return false;
                    }
                } else {
                    sample_rate = Some(rate);
                }
                saw_audio = true;
            }
            Ok(None) => {
                // Missing audio on one segment → cannot copy a continuous track.
                return false;
            }
            Err(_) => return false,
        }
    }
    saw_audio
}

pub fn parse_vcodec_from_probe(stderr: &str) -> Option<VideoCodec> {
    let caps = VIDEO_STREAM_RE.captures(stderr)?;
    Some(normalize_vcodec_name(caps.get(1)?.as_str()))
}

/// Parse first I-frame `pts_time` from ffmpeg `showinfo` stderr.
pub fn parse_first_keyframe_time(stderr: &str) -> Option<f64> {
    parse_keyframe_times(stderr).into_iter().next()
}

/// All I-frame / keyframe `pts_time` values from ffmpeg `showinfo` stderr.
pub fn parse_keyframe_times(stderr: &str) -> Vec<f64> {
    let mut times = Vec::new();
    for caps in SHOWINFO_TYPE_RE.captures_iter(stderr) {
        let Some(pict) = caps.get(2).map(|m| m.as_str().to_uppercase()) else {
            continue;
        };
        if pict != "I" {
            continue;
        }
        if let Some(Ok(t)) = caps.get(1).map(|m| m.as_str().parse::<f64>()) {
            times.push(t);
        }
    }
    if !times.is_empty() {
        return times;
    }
    // `-skip_frame nokey` path: every showinfo pts_time is a keyframe.
    for caps in SHOWINFO_PTS_RE.captures_iter(stderr) {
        if let Some(Ok(t)) = caps.get(1).map(|m| m.as_str().parse::<f64>()) {
            if times.last().copied() != Some(t) {
                times.push(t);
            }
        }
    }
    times
}

/// First keyframe time at or after `min_secs` (within floating epsilon).
pub fn keyframe_at_or_after(times: &[f64], min_secs: f64) -> Option<f64> {
    let floor = min_secs - 1e-6;
    times.iter().copied().find(|&t| t >= floor)
}

/// Last keyframe time at or before `max_secs` (within floating epsilon).
pub fn keyframe_at_or_before(times: &[f64], max_secs: f64) -> Option<f64> {
    let ceil = max_secs + 1e-6;
    times.iter().copied().rev().find(|&t| t <= ceil)
}

/// Nearest keyframe to `target_secs` (empty list → `None`).
#[allow(dead_code)] // used by unit tests + available for callers
pub fn nearest_keyframe(times: &[f64], target_secs: f64) -> Option<f64> {
    if times.is_empty() {
        return None;
    }
    times
        .iter()
        .copied()
        .min_by(|a, b| {
            let da = (a - target_secs).abs();
            let db = (b - target_secs).abs();
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// Snap a keep-range to stream-copy-friendly keyframes.
///
/// - Start → keyframe at or before (floor)
/// - End → keyframe at or after (ceil)
///
/// Guarantees `end > start` when at least two distinct keyframes exist; otherwise
/// falls back to the raw range (clamped).
#[allow(dead_code)] // used by unit tests + frontend parity helper
pub fn snap_trim_range_to_keyframes(
    times: &[f64],
    start_secs: f64,
    end_secs: f64,
) -> (f64, f64) {
    let mut start = start_secs.max(0.0);
    let mut end = end_secs.max(start);
    if times.is_empty() {
        return (start, end);
    }

    if let Some(s) = keyframe_at_or_before(times, start) {
        start = s;
    } else if let Some(s) = keyframe_at_or_after(times, start) {
        start = s;
    }

    if let Some(e) = keyframe_at_or_after(times, end) {
        end = e;
    } else if let Some(e) = keyframe_at_or_before(times, end) {
        end = e;
    }

    if end <= start {
        // Pick the next keyframe after start when ceil collapsed onto start.
        if let Some(e) = times.iter().copied().find(|&t| t > start + 1e-6) {
            end = e;
        }
    }

    if end <= start {
        (start_secs.max(0.0), end_secs.max(start_secs.max(0.0) + 0.1))
    } else {
        (start, end)
    }
}

/// List all keyframe timestamps (seconds) for `video_path`.
///
/// Scans the full duration via FFmpeg `showinfo` (`-skip_frame nokey`).
/// When `duration_hint` is `Some(>0)`, skips an extra duration probe.
pub fn list_keyframes(
    ffmpeg: &Path,
    video_path: &str,
    duration_hint: Option<f64>,
) -> Result<Vec<f64>, ConcatError> {
    if !Path::new(video_path).is_file() {
        return Err(ConcatError::Message(format!(
            "input file not found: {video_path}"
        )));
    }
    let duration = duration_hint
        .filter(|d| d.is_finite() && *d > 0.0)
        .or_else(|| probe_duration_secs(ffmpeg, video_path).ok())
        .unwrap_or(0.0);
    let scan = if duration > 0.0 {
        duration + 1.0
    } else {
        3600.0
    };

    let args = build_keyframe_scan_args(video_path, scan);
    let (_code, stderr) = run_ffmpeg_capture_stderr(ffmpeg, &args)?;
    let mut times = parse_keyframe_times(&stderr);
    if times.is_empty() {
        let args2 = build_keyframe_scan_args_pict_type(video_path, scan);
        let (_c2, stderr2) = run_ffmpeg_capture_stderr(ffmpeg, &args2)?;
        times = parse_keyframe_times(&stderr2);
    }
    Ok(times)
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

/// First I-frame at or after `min_secs` within a `max_scan_sec` showinfo scan.
pub fn get_keyframe_at_or_after(
    ffmpeg: &Path,
    video_path: &str,
    min_secs: f64,
    max_scan_sec: f64,
) -> Option<f64> {
    let scan = max_scan_sec.max(min_secs + 0.5);
    let args = build_keyframe_scan_args(video_path, scan);
    let (_code, stderr) = run_ffmpeg_capture_stderr(ffmpeg, &args).ok()?;
    let times = parse_keyframe_times(&stderr);
    if let Some(t) = keyframe_at_or_after(&times, min_secs) {
        return Some(t);
    }
    // Retry with pict_type select (older / edge-case streams).
    let args2 = build_keyframe_scan_args_pict_type(video_path, scan);
    let (_code2, stderr2) = run_ffmpeg_capture_stderr(ffmpeg, &args2).ok()?;
    keyframe_at_or_after(&parse_keyframe_times(&stderr2), min_secs)
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
///
/// When `body_concat_mode` is `fast`, uses a single concat-demuxer remux. On failure
/// with an ask callback, the user may abort or switch to the legacy MPEG-TS path.
/// Without a callback (e.g. preview), fast failure falls back to legacy silently.
///
/// Mode `compatible` uses Clean Ein-Pass or Dirty TS-Prep (probe gate + AUD/tag hygiene).
/// On FFmpeg failure: same Ask/silent-Legacy parity as Fast — never falls back to Fast.
/// Clean-Fail prefers one Dirty retry before Ask (Phase 43.3).
pub fn concat_videos_stream_copy_only(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    on_progress: ProgressCallback,
) -> Result<ConcatOutcome, ConcatError> {
    concat_videos_stream_copy_only_with_mode(
        ffmpeg,
        paths,
        output,
        on_progress,
        "legacy",
        None,
    )
}

/// Like [`concat_videos_stream_copy_only`], with explicit body-concat mode + optional ask.
pub fn concat_videos_stream_copy_only_with_mode(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    on_progress: ProgressCallback,
    body_concat_mode: &str,
    on_fast_fail: Option<&BodyConcatAskFn>,
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

    let compatible_mode = is_compatible_body_concat_mode(body_concat_mode);

    // OPT-16: skip "Analysiere Videos…" when every clip is already cached.
    let all_cached_peek = paths.iter().all(|p| probe_cache::get(p).is_some());
    if should_emit_probing_progress(all_cached_peek) {
        emit(&on_progress, 2.0, "probing");
    }

    // One probe pass for all modes (cache hit or parallel miss).
    let (cached_probes, all_from_cache) =
        probe_cache::resolve_clips_parallel(ffmpeg, paths, |done, total, name| {
            let _ = (done, total, name);
        })
        .map_err(|e| match e {
            super::parallel::ParallelError::Cancelled => {
                ConcatError::Ffmpeg(FfmpegError::Cancelled)
            }
            super::parallel::ParallelError::Message(m) => ConcatError::Message(m),
        })?;

    let clip_probes: Vec<ClipConcatProbe> = cached_probes
        .iter()
        .map(ClipConcatProbe::from_cached)
        .collect();
    let codecs: Vec<VideoCodec> = clip_probes.iter().map(|p| p.vcodec).collect();
    let has_audio_flags: Vec<bool> = clip_probes.iter().map(|p| p.has_audio).collect();
    let total_secs: f64 = clip_probes.iter().map(|p| p.duration_secs).sum();
    let compatible_probes: Option<Vec<ClipConcatProbe>> = if compatible_mode {
        Some(clip_probes.clone())
    } else {
        None
    };
    // Emit compatible-probe only when gate runs now (cache miss) and multi-clip.
    let emit_compatible_probe_progress =
        should_emit_compatible_probe_progress(compatible_mode, all_from_cache, paths.len());

    let all_same = codecs.windows(2).all(|w| w[0] == w[1]);
    let vcodec = codecs[0];
    let has_audio = has_audio_flags.iter().all(|&a| a);
    let stream_copy_ok =
        all_same && matches!(vcodec, VideoCodec::H264 | VideoCodec::Hevc);

    if stream_copy_ok {
        let use_fast = is_fast_body_concat_mode(body_concat_mode);
        let use_compatible = is_compatible_body_concat_mode(body_concat_mode);

        if use_fast {
            match concat_stream_copy_fast(
                ffmpeg,
                paths,
                output,
                has_audio,
                total_secs,
                &on_progress,
            ) {
                Ok(()) => {
                    emit(&on_progress, 100.0, "end");
                    return Ok(ConcatOutcome {
                        method: "stream-copy-fast".into(),
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
                    let reason = format!("Fast Path fehlgeschlagen: {e}");
                    match handle_body_concat_path_fail(
                        &on_progress,
                        on_fast_fail,
                        &reason,
                        "Fast Path fehlgeschlagen — warte auf Entscheidung…",
                    ) {
                        Ok(()) => {
                            // Fall through to legacy MPEG-TS.
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        } else if use_compatible {
            match concat_stream_copy_compatible(
                ffmpeg,
                paths,
                output,
                vcodec,
                has_audio,
                total_secs,
                &on_progress,
                compatible_probes.as_ref().expect("compatible probes"),
                emit_compatible_probe_progress,
            ) {
                Ok(()) => {
                    emit(&on_progress, 100.0, "end");
                    return Ok(ConcatOutcome {
                        method: "stream-copy-compatible".into(),
                        codec: vcodec.as_str().into(),
                        reencode_reason: None,
                    });
                }
                Err(ConcatError::NeedsReencode { reason }) => {
                    // Probe-gate / hard incompatibility — do not Ask Legacy here.
                    return Err(ConcatError::NeedsReencode { reason });
                }
                Err(e) => {
                    if concat_error_is_disk_full(&e) {
                        return Err(ConcatError::Ffmpeg(disk_full_error()));
                    }
                    if matches!(&e, ConcatError::Ffmpeg(FfmpegError::Cancelled)) {
                        return Err(e);
                    }
                    let _ = fs::remove_file(output);
                    let reason = format!("Compatible Path fehlgeschlagen: {e}");
                    match handle_body_concat_path_fail(
                        &on_progress,
                        on_fast_fail,
                        &reason,
                        "Compatible Path fehlgeschlagen — warte auf Entscheidung…",
                    ) {
                        Ok(()) => {
                            // Fall through to legacy MPEG-TS (never to Fast).
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }

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

/// Shared Ask / silent-Legacy handling for Fast or Compatible path failure.
fn handle_body_concat_path_fail(
    on_progress: &ProgressCallback,
    on_fail: Option<&BodyConcatAskFn>,
    reason: &str,
    wait_status: &str,
) -> Result<(), ConcatError> {
    match on_fail {
        Some(ask) => {
            emit(on_progress, 40.0, wait_status);
            match ask(reason) {
                Ok(BodyConcatChoice::UseLegacy) => {
                    emit(on_progress, 45.0, "Legacy-Zusammenfügen (MPEG-TS)…");
                    Ok(())
                }
                Ok(BodyConcatChoice::Abort) | Err(()) => {
                    Err(ConcatError::Ffmpeg(FfmpegError::Cancelled))
                }
            }
        }
        // Preview / silent path: keep going with legacy.
        None => {
            emit(on_progress, 45.0, "Legacy-Zusammenfügen (MPEG-TS)…");
            Ok(())
        }
    }
}

/// True when settings request the fast concat-demuxer path.
pub fn is_fast_body_concat_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "fast" | "fast_path" | "fast-path"
    )
}

/// True when settings request the Compatible (QT-safe prepared) stream-copy path.
pub fn is_compatible_body_concat_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "compatible" | "compat" | "qt_safe" | "prepared" | "avidemux"
    )
}

/// Whether Create should emit the generic `probing` / „Analysiere Videos…“ step (OPT-16).
///
/// Skipped when a peek shows every clip is already in the process-local probe cache.
pub fn should_emit_probing_progress(all_from_cache: bool) -> bool {
    !all_from_cache
}

/// Whether Create should emit the `compatible-probe` progress step (OPT-16).
///
/// Skipped when every clip was a process-local cache hit (gate still runs silently).
pub fn should_emit_compatible_probe_progress(
    compatible_mode: bool,
    all_from_cache: bool,
    clip_count: usize,
) -> bool {
    compatible_mode && !all_from_cache && clip_count > 1
}

/// Single-pass concat demuxer + stream-copy (naive Fast Path).
fn concat_stream_copy_fast(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    if is_cancelled() {
        return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
    }
    let work = make_work_dir("concat_fast")?;
    let list_path = work.join("concat_list.txt");
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&refs, &list_path)?;

    emit(on_progress, 0.0, "fast-concat");
    let args = build_concat_demuxer_copy_args(&path_str(&list_path), output, has_audio);
    let result = run_ffmpeg(ffmpeg, &args, total_secs, on_progress.clone());
    let _ = fs::remove_dir_all(&work);

    match result {
        Ok(()) => Ok(()),
        Err(e) if is_disk_full_error(&e) => Err(ConcatError::Ffmpeg(disk_full_error())),
        Err(e) => {
            let _ = fs::remove_file(output);
            Err(ConcatError::Ffmpeg(e))
        }
    }
}

/// Probe gate for Compatible path: matching codec / size / pix_fmt / audio / rotation.
fn compatible_probe_gate_keys(
    keys: &[CompatibleStreamKey],
    has_audio_expected: bool,
) -> Result<(), ConcatError> {
    for (clip_index, key) in keys.iter().enumerate() {
        if let Some(reason) =
            super::probe::compatible_orientation_unreliable_reason(key.rotation, clip_index + 1)
        {
            return Err(ConcatError::NeedsReencode { reason });
        }
    }

    let first = &keys[0];
    let first_rot = first.rotation.known_degrees().unwrap_or(0);
    for (i, key) in keys.iter().enumerate().skip(1) {
        if !super::probe::compatible_stream_keys_match(first, key) {
            let key_rot = key.rotation.known_degrees().unwrap_or(0);
            let reason = if first_rot != key_rot {
                super::probe::compatible_orientation_mismatch_reason(first_rot, i + 1, key_rot)
            } else if first.width != key.width || first.height != key.height {
                format!(
                    "Compatible Path: unterschiedliche Auflösung ({}x{} vs {}x{})",
                    first.width, first.height, key.width, key.height
                )
            } else if first.pix_fmt != key.pix_fmt {
                format!(
                    "Compatible Path: unterschiedliches Pixelformat ({} vs {})",
                    first.pix_fmt, key.pix_fmt
                )
            } else if first.has_audio != key.has_audio {
                "Compatible Path: gemischte Audio-Präsenz".into()
            } else if first.codec != key.codec {
                format!(
                    "Compatible Path: unterschiedliche Codecs ({} vs {})",
                    first.codec, key.codec
                )
            } else {
                format!(
                    "Compatible Path: Clips nicht kompatibel (Clip1 vs Clip{})",
                    i + 1
                )
            };
            return Err(ConcatError::NeedsReencode { reason });
        }
    }

    let _ = has_audio_expected;
    Ok(())
}

/// MKV remux fallback when direct TS→MP4 concat fails (stream-copy).
///
/// Remuxes each prep `.ts` to a temp MP4 first (dimensions for the muxer), then
/// concat→MKV→MP4 like Legacy — never concat MPEG-TS straight into Matroska.
fn compatible_mkv_merge_from_prep(
    ffmpeg: &Path,
    work: &Path,
    prepared_ts_paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    let mut mp4_paths: Vec<String> = Vec::with_capacity(prepared_ts_paths.len());
    for (i, ts) in prepared_ts_paths.iter().enumerate() {
        if is_cancelled() {
            return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
        }
        let mp4 = work.join(format!("seg_{i}_mkv_prep.mp4"));
        let mp4_str = path_str(&mp4);
        let remux_args =
            build_compatible_ts_segment_to_mp4_args(ts, &mp4_str, vcodec, has_audio);
        match run_ffmpeg_checked(ffmpeg, &remux_args) {
            Err(e) if is_disk_full_error(&e) => {
                return Err(ConcatError::Ffmpeg(disk_full_error()));
            }
            Err(e) => return Err(ConcatError::Ffmpeg(e)),
            Ok(()) => {}
        }
        mp4_paths.push(mp4_str);
    }

    let list_path = work.join("mkv_prep_concat_list.txt");
    let refs: Vec<&str> = mp4_paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&refs, &list_path)?;
    let list_str = path_str(&list_path);

    let mkv = work.join("splice_concat.mkv");
    let mkv_args = build_concat_mp4_to_mkv_args(&list_str, &path_str(&mkv));
    match run_ffmpeg_checked(ffmpeg, &mkv_args) {
        Err(e) if is_disk_full_error(&e) => return Err(ConcatError::Ffmpeg(disk_full_error())),
        Err(e) => return Err(ConcatError::Ffmpeg(e)),
        Ok(()) => {}
    }

    let video_tag = match vcodec {
        VideoCodec::Hevc => hevc_stream_copy_video_tag(),
        _ => "avc1",
    };
    let merge_tmp = work.join("compatible_merge.mp4");
    let merge_tmp_str = path_str(&merge_tmp);
    let mut remux_args = build_remux_mkv_to_mp4_args(
        &path_str(&mkv),
        &merge_tmp_str,
        vcodec,
        has_audio,
        video_tag,
    );
    // TS→MP4 segment remux already applied AUD/tag — do not insert AUD again.
    omit_video_aud_insert_bsf(&mut remux_args);
    omit_faststart_movflags(&mut remux_args);
    let output_arg = remux_args
        .pop()
        .ok_or_else(|| ConcatError::Message("remux args missing output".into()))?;
    remux_args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ]);
    remux_args.push(output_arg);
    match run_ffmpeg(ffmpeg, &remux_args, total_secs, on_progress.clone()) {
        Err(e) if is_disk_full_error(&e) => return Err(ConcatError::Ffmpeg(disk_full_error())),
        Err(e) => return Err(ConcatError::Ffmpeg(e)),
        Ok(()) => {}
    }
    compatible_finalize_faststart(
        ffmpeg,
        &merge_tmp_str,
        output,
        has_audio,
        total_secs,
        on_progress,
    )
}

/// Primary Compatible merge: prep TS list → temp MP4 (no faststart) → finalize.
fn compatible_merge_from_prep(
    ffmpeg: &Path,
    work: &Path,
    prepared_ts_paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    let list_path = work.join("prep_concat_list.txt");
    let refs: Vec<&str> = prepared_ts_paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&refs, &list_path)?;
    let list_str = path_str(&list_path);
    let merge_tmp = work.join("compatible_merge.mp4");
    let merge_tmp_str = path_str(&merge_tmp);

    emit(on_progress, 0.0, "compatible-concat");
    let concat_args =
        build_compatible_mpegts_concat_to_mp4_args(&list_str, &merge_tmp_str, vcodec, has_audio);
    let result = run_ffmpeg(ffmpeg, &concat_args, total_secs, on_progress.clone());

    match result {
        Ok(()) => compatible_finalize_faststart(
            ffmpeg,
            &merge_tmp_str,
            output,
            has_audio,
            total_secs,
            on_progress,
        ),
        Err(e) if is_disk_full_error(&e) => Err(ConcatError::Ffmpeg(disk_full_error())),
        Err(e) => {
            log_compatible_merge_failure("Compatible", ffmpeg, &concat_args, &e);
            emit(on_progress, 0.0, "compatible-mkv-fallback");
            compatible_mkv_merge_from_prep(
                ffmpeg,
                work,
                prepared_ts_paths,
                output,
                vcodec,
                has_audio,
                total_secs,
                on_progress,
            )
        }
    }
}

/// Phase 43.1: second progress pass — `+faststart` remux with status `compatible-finalize`.
///
/// Status-only kickoff uses percent 0; the UI keeps the prior overall % (monotonic)
/// so this remux does not restart the bar after concat.
fn compatible_finalize_faststart(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    emit(on_progress, 0.0, "compatible-finalize");
    let outer = on_progress.clone();
    // Remux out_time restarts at 0 — keep status on finalize and let UI monotonic
    // clamp ignore regressing percents (no second 0→100 flash).
    let finalize_cb: ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let mut q = p;
        if q.status == "continue" || q.status == "end" || q.status.is_empty() {
            q.status = "compatible-finalize".into();
        }
        outer(q);
    });
    let args = build_compatible_finalize_faststart_args(input, output, has_audio);
    match run_ffmpeg(ffmpeg, &args, total_secs, finalize_cb) {
        Err(e) if is_disk_full_error(&e) => Err(ConcatError::Ffmpeg(disk_full_error())),
        Err(e) => Err(ConcatError::Ffmpeg(e)),
        Ok(()) => Ok(()),
    }
}

/// Prepared QT-safe stream-copy: probe gate → Clean Ein-Pass | Dirty TS-Prep → finalize.
///
/// Phase 43.3: Clean-Fail → one Dirty retry (never silent Fast). Cancel/disk-full stay fatal.
fn concat_stream_copy_compatible(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
    clip_probes: &[ClipConcatProbe],
    emit_probe_progress: bool,
) -> Result<(), ConcatError> {
    if is_cancelled() {
        return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
    }

    // OPT-16: skip "compatible-probe" UI step when all clips were cache hits.
    if emit_probe_progress {
        emit(on_progress, 0.0, "compatible-probe");
    }
    let keys: Vec<CompatibleStreamKey> = clip_probes
        .iter()
        .map(|p| p.compatible_key.clone())
        .collect();
    compatible_probe_gate_keys(&keys, has_audio)?;

    let clean = compatible_clips_are_clean(&keys);
    if clean {
        logging::info("concat", "compatible: clean-pass");
        match concat_compatible_clean_pass(
            ffmpeg,
            paths,
            output,
            vcodec,
            has_audio,
            total_secs,
            on_progress,
        ) {
            Ok(()) => {
                compatible_validate_output(
                    ffmpeg,
                    output,
                    clip_probes,
                    on_progress,
                    false,
                    vcodec,
                )?;
                return Ok(());
            }
            Err(e) if concat_error_is_disk_full(&e) => {
                return Err(ConcatError::Ffmpeg(disk_full_error()));
            }
            Err(e) if matches!(&e, ConcatError::Ffmpeg(FfmpegError::Cancelled)) => {
                return Err(e);
            }
            Err(e) => {
                // Prefer one Dirty retry before Ask Legacy (never silent Fast).
                logging::warn(
                    "concat",
                    format!("compatible clean-pass failed — dirty retry (ts-prep): {e}"),
                );
                let _ = fs::remove_file(output);
            }
        }
    } else {
        logging::info("concat", "compatible: ts-prep");
    }

    concat_compatible_ts_prep(
        ffmpeg,
        paths,
        output,
        vcodec,
        has_audio,
        total_secs,
        on_progress,
        clip_probes,
    )
}

/// Clean Ein-Pass: source list → concat+copy+AUD/tag (no Prep) → finalize faststart.
fn concat_compatible_clean_pass(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
) -> Result<(), ConcatError> {
    if is_cancelled() {
        return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
    }
    let work = make_work_dir("concat_compatible_clean")?;
    let list_path = work.join("concat_list.txt");
    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&refs, &list_path)?;
    let merge_tmp = work.join("compatible_merge.mp4");
    let merge_tmp_str = path_str(&merge_tmp);

    emit(on_progress, 0.0, "compatible-concat");
    let args = build_compatible_clean_concat_args(
        &path_str(&list_path),
        &merge_tmp_str,
        vcodec,
        has_audio,
    );
    let result = run_ffmpeg(ffmpeg, &args, total_secs, on_progress.clone());
    match result {
        Err(e) if is_disk_full_error(&e) => {
            let _ = fs::remove_dir_all(&work);
            return Err(ConcatError::Ffmpeg(disk_full_error()));
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&work);
            return Err(ConcatError::Ffmpeg(e));
        }
        Ok(()) => {}
    }

    let finalize = compatible_finalize_faststart(
        ffmpeg,
        &merge_tmp_str,
        output,
        has_audio,
        total_secs,
        on_progress,
    );
    let _ = fs::remove_dir_all(&work);
    finalize
}

/// Dirty path (Phase 43.2/43.4): parallel MPEG-TS prep (+ optional cache) → merge → validate.
fn concat_compatible_ts_prep(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    vcodec: VideoCodec,
    has_audio: bool,
    total_secs: f64,
    on_progress: &ProgressCallback,
    clip_probes: &[ClipConcatProbe],
) -> Result<(), ConcatError> {
    let n = paths.len();
    emit(
        on_progress,
        compatible_prep_progress_percent(0, n),
        &compatible_prep_status(0, n),
    );

    let work = make_work_dir("concat_compatible")?;
    // Remux/prep is stream-copy — do not tie worker count to NVENC availability.
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(2);
    let pool = ParallelVideoProcessor {
        max_workers: compatible_remux_prep_worker_count(n),
        hw_accel_enabled: false,
        cpu_count,
    };
    let ffmpeg_path = ffmpeg.to_path_buf();
    let paths_owned: Vec<String> = paths.to_vec();
    let work_dir = work.clone();
    let progress = on_progress.clone();
    let done_count = Arc::new(AtomicUsize::new(0));
    let vcodec_key = vcodec.as_str();

    let prep_results = pool.process_indexed(
        n,
        |i, _task_id| -> Result<String, ConcatError> {
            if is_cancelled() {
                return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
            }
            let done = done_count.load(Ordering::Relaxed);
            progress(EncodeProgress {
                percent: compatible_prep_progress_percent(done, n),
                current_secs: 0.0,
                total_secs: 0.0,
                status: compatible_prep_status(done, n),
                task_id: None,
            });

            let src = &paths_owned[i];
            // Phase 43.4: reuse TS segment when source identity matches.
            if let Some(cached) = prep_cache::get(src, vcodec_key, has_audio) {
                let completed = done_count.fetch_add(1, Ordering::Relaxed) + 1;
                progress(EncodeProgress {
                    percent: compatible_prep_progress_percent(completed, n),
                    current_secs: 0.0,
                    total_secs: 0.0,
                    status: compatible_prep_status(completed, n),
                    task_id: None,
                });
                return Ok(path_str(&cached));
            }

            // Phase 43.2: one-pass hygiene → MPEG-TS (no intermediate MP4).
            let (prep, prep_args) = compatible_dirty_prep_plan(
                &work_dir,
                i,
                src,
                vcodec,
                has_audio,
            );
            run_ffmpeg_checked(&ffmpeg_path, &prep_args)?;
            // Prefer cached path for merge so work-dir cleanup cannot invalidate reuse.
            let prep_path = prep_cache::put(src, vcodec_key, has_audio, &prep)
                .unwrap_or(prep);

            let completed = done_count.fetch_add(1, Ordering::Relaxed) + 1;
            progress(EncodeProgress {
                percent: compatible_prep_progress_percent(completed, n),
                current_secs: 0.0,
                total_secs: 0.0,
                status: compatible_prep_status(completed, n),
                task_id: None,
            });
            Ok(path_str(&prep_path))
        },
        None,
    )?;

    let mut prep_paths: Vec<String> = Vec::with_capacity(n);
    for result in prep_results {
        prep_paths.push(result?);
    }

    // Merge reports its own 0→100%; finalize keeps status without restarting the UI bar.
    compatible_merge_from_prep(
        ffmpeg,
        &work,
        &prep_paths,
        output,
        vcodec,
        has_audio,
        total_secs,
        on_progress,
    )?;

    compatible_validate_output(
        ffmpeg,
        output,
        clip_probes,
        on_progress,
        true,
        vcodec,
    )?;
    let _ = fs::remove_dir_all(&work);
    Ok(())
}

fn compatible_validate_output(
    ffmpeg: &Path,
    output: &str,
    clip_probes: &[ClipConcatProbe],
    on_progress: &ProgressCallback,
    dirty: bool,
    vcodec: VideoCodec,
) -> Result<(), ConcatError> {
    if clip_probes.is_empty() || clip_probes[0].duration_secs <= 0.0 {
        return Ok(());
    }
    if !compatible_should_validate_splice(dirty, vcodec, false) {
        return Ok(());
    }
    emit(on_progress, 100.0, "compatible-validate");
    let (ok, reason) = validate_splice_decode(
        ffmpeg,
        output,
        clip_probes[0].duration_secs,
        2.0,
    );
    if !ok {
        let _ = fs::remove_file(output);
        return Err(ConcatError::Message(format!(
            "compatible splice validation failed: {reason}"
        )));
    }
    Ok(())
}

/// Re-encode concat via demuxer (public for intro-mux fallback after user consent).
///
/// Uses the first clip's video codec. Hardware encode only when `hw_accel_enabled`.
pub fn concat_videos_reencode(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    reason: &str,
    on_progress: ProgressCallback,
    hw_accel_enabled: bool,
    crf: u8,
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
    let (cached_probes, _) = probe_cache::resolve_clips_parallel(ffmpeg, paths, |_, _, _| {})
        .map_err(|e| match e {
            super::parallel::ParallelError::Cancelled => {
                ConcatError::Ffmpeg(FfmpegError::Cancelled)
            }
            super::parallel::ParallelError::Message(m) => ConcatError::Message(m),
        })?;
    let total_secs: f64 = cached_probes.iter().map(|p| p.duration_secs).sum();
    let vcodec = normalize_vcodec_name(&cached_probes[0].codec);
    let encoder = concat_reencode(
        ffmpeg,
        paths,
        output,
        vcodec,
        total_secs,
        reason,
        hw_accel_enabled,
        crf,
        &on_progress,
    )?;
    emit(&on_progress, 100.0, "end");
    Ok(ConcatOutcome {
        method: "re-encode".into(),
        codec: encoder,
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
    concat_videos_with_opts(
        ffmpeg,
        paths,
        output,
        on_progress,
        false,
        18,
        "legacy",
        None,
        None,
    )
}

/// Like [`concat_videos`], with explicit encode options for the re-encode fallback.
pub fn concat_videos_with_opts(
    ffmpeg: &Path,
    paths: &[String],
    output: &str,
    on_progress: ProgressCallback,
    hw_accel_enabled: bool,
    crf: u8,
    body_concat_mode: &str,
    on_fast_fail: Option<&BodyConcatAskFn>,
    on_reencode: Option<&ReencodeAskFn>,
) -> Result<ConcatOutcome, ConcatError> {
    match concat_videos_stream_copy_only_with_mode(
        ffmpeg,
        paths,
        output,
        Arc::clone(&on_progress),
        body_concat_mode,
        on_fast_fail,
    ) {
        Ok(outcome) => Ok(outcome),
        Err(ConcatError::NeedsReencode { reason }) => {
            let intent = ReencodeIntent::new(ReencodeKind::ConcatFallback, reason.clone())
                .with_params(ReencodeParams {
                    crf: Some(crf),
                    hw_accel: Some(hw_accel_enabled),
                    clip_count: Some(paths.len()),
                    strategy: Some("concat_reencode".into()),
                    ..Default::default()
                });
            emit(
                &on_progress,
                40.0,
                "Neu-Kodierung — warte auf Bestätigung…",
            );
            let profile = reencode_confirm::require_confirm(on_reencode, &intent)
                .map_err(|_| ConcatError::Ffmpeg(FfmpegError::Cancelled))?;
            emit(
                &on_progress,
                42.0,
                &format!("Kodiere neu: {reason}"),
            );
            concat_videos_reencode(
                ffmpeg,
                paths,
                output,
                &reason,
                on_progress,
                profile.hw_accel,
                profile.crf,
            )
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

    let ts_list_path = work.join("ts_concat_list.txt");
    let ts_refs: Vec<&str> = ts_paths.iter().map(|s| s.as_str()).collect();
    write_concat_file_list(&ts_refs, &ts_list_path)?;

    let concat_args = build_mpegts_concat_to_mp4_args(
        &path_str(&ts_list_path),
        output,
        vcodec,
        has_audio,
        video_tag,
    );

    // Prefer progress-aware run for the final mux
    let result = run_ffmpeg(ffmpeg, &concat_args, total_secs, on_progress.clone());

    if let Err(ref e) = result {
        if is_disk_full_error(e) {
            return Err(ConcatError::Ffmpeg(disk_full_error()));
        }
    }

    if result.is_err() && vcodec == VideoCodec::Hevc {
        if let Err(ref e) = result {
            log_compatible_merge_failure("Legacy", ffmpeg, &concat_args, e);
        }
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
    vcodec: VideoCodec,
    total_secs: f64,
    reason: &str,
    hw_accel_enabled: bool,
    crf: u8,
    on_progress: &ProgressCallback,
) -> Result<String, ConcatError> {
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
    let force_software = !hw_accel_enabled || !hw.available;
    let (encoder, output_params) =
        crate::video::encoding_quality::build_encode_output_params(
            &hw,
            vcodec,
            crf,
            force_software,
        );
    let params = EncodingParams {
        input_params: Vec::new(),
        output_params,
        encoder: encoder.clone(),
    };
    let copy_audio = inputs_allow_aac_audio_copy(ffmpeg, paths);
    let args = build_concat_demuxer_reencode_args(
        &path_str(&list_path),
        output,
        &params,
        copy_audio,
    );

    run_ffmpeg(ffmpeg, &args, total_secs, on_progress.clone())?;
    let _ = fs::remove_dir_all(&work);
    Ok(encoder)
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

    if Path::new(input) == Path::new(output) {
        crate::storage::file_link::materialize_hardlink(Path::new(input))
            .map_err(|e| ConcatError::Message(e.to_string()))?;
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
    fn keyframe_at_or_after_picks_next_idr() {
        let times = parse_keyframe_times(
            r#"
pts_time:0.000000 type:I
pts_time:1.000000 type:P
pts_time:2.000000 type:I
pts_time:4.000000 type:I
"#,
        );
        assert_eq!(times, vec![0.0, 2.0, 4.0]);
        assert!((keyframe_at_or_after(&times, 1.0).unwrap() - 2.0).abs() < 0.001);
        assert!((keyframe_at_or_after(&times, 2.0).unwrap() - 2.0).abs() < 0.001);
        assert!(keyframe_at_or_after(&times, 5.0).is_none());
    }

    #[test]
    fn keyframe_at_or_before_and_nearest() {
        let times = vec![0.0, 2.0, 4.0];
        assert!((keyframe_at_or_before(&times, 1.5).unwrap() - 0.0).abs() < 0.001);
        assert!((keyframe_at_or_before(&times, 2.0).unwrap() - 2.0).abs() < 0.001);
        assert!(keyframe_at_or_before(&times, -0.1).is_none());
        assert!((nearest_keyframe(&times, 1.4).unwrap() - 2.0).abs() < 0.001);
        assert!((nearest_keyframe(&times, 0.4).unwrap() - 0.0).abs() < 0.001);
    }

    #[test]
    fn snap_trim_range_floors_start_ceils_end() {
        let times = vec![0.0, 1.0, 2.0, 3.0, 4.0];
        let (s, e) = snap_trim_range_to_keyframes(&times, 0.4, 2.3);
        assert!((s - 0.0).abs() < 0.001);
        assert!((e - 3.0).abs() < 0.001);

        let (s2, e2) = snap_trim_range_to_keyframes(&times, 2.0, 2.0);
        assert!((s2 - 2.0).abs() < 0.001);
        assert!((e2 - 3.0).abs() < 0.001);
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
    fn format_ffmpeg_command_quotes_spaces() {
        let cmd = format_ffmpeg_command(
            Path::new("ffmpeg.exe"),
            &[
                "-i".into(),
                "C:\\temp\\a b.ts".into(),
                "-y".into(),
            ],
        );
        assert!(cmd.contains("ffmpeg.exe"));
        assert!(cmd.contains("\"C:\\temp\\a b.ts\""));
    }

    #[test]
    fn prep_hevc_splice_inserts_aud_and_tag() {
        let args = build_prep_hevc_splice_args("a.mp4", "b.mp4", true, "hev1");
        assert!(args.contains(&"hevc_metadata=aud=insert".into()));
        assert!(args.contains(&"-tag:v".into()));
        assert!(args.contains(&"hev1".into()));
    }

    #[test]
    fn prep_compatible_h264_and_hevc_args() {
        let h264 = build_prep_compatible_args("in.mp4", "out.mp4", VideoCodec::H264, true, true);
        assert!(h264.contains(&"-ignore_editlist".into()));
        assert!(h264.contains(&"-noautorotate".into()));
        assert!(h264.contains(&"h264_metadata=aud=insert".into()));
        assert!(h264.contains(&"avc1".into()));
        assert!(h264.contains(&"-display_rotation".into()));
        assert!(h264.contains(&"rotate=0".into()));
        assert!(h264.contains(&"+genpts".into()));
        assert!(h264.contains(&"make_zero".into()));
        assert!(
            !h264.iter().any(|a| a == "+faststart"),
            "intermediate prep must not use +faststart"
        );
        let i_pos = h264.iter().position(|a| a == "-i").expect("-i");
        let rot_pos = h264
            .iter()
            .position(|a| a == "-display_rotation")
            .expect("-display_rotation");
        assert!(
            rot_pos < i_pos,
            "display_rotation must be an input option (before -i)"
        );

        let hevc = build_prep_compatible_args("in.mp4", "out.mp4", VideoCodec::Hevc, false, false);
        assert!(!hevc.iter().any(|a| a == "-ignore_editlist"));
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"hev1".into()));
        assert!(!hevc.iter().any(|a| a == "0:a:0"));
    }

    #[test]
    fn prep_compatible_to_mpegts_single_pass() {
        let h264 = build_prep_compatible_to_mpegts_args(
            "in.mp4",
            "out.ts",
            VideoCodec::H264,
            true,
            true,
        );
        // Annex-B only in prep; AUD/tag on merge (Legacy-compatible split).
        assert!(h264.contains(&"h264_mp4toannexb".into()));
        assert!(!h264.iter().any(|a| a.contains("aud=insert")));
        assert!(h264.contains(&"-f".into()));
        assert!(h264.contains(&"mpegts".into()));
        assert!(h264.contains(&"out.ts".into()));
        assert!(!h264.iter().any(|a| a == "+faststart"));

        let hevc = build_prep_compatible_to_mpegts_args(
            "in.mp4",
            "out.ts",
            VideoCodec::Hevc,
            false,
            false,
        );
        assert!(hevc.contains(&"hevc_mp4toannexb".into()));
        assert!(!hevc.iter().any(|a| a.contains("aud=insert")));
        let i_pos = hevc.iter().position(|a| a == "-i").expect("-i");
        let rot_pos = hevc
            .iter()
            .position(|a| a == "-display_rotation")
            .expect("-display_rotation");
        assert!(rot_pos < i_pos);
    }

    #[test]
    fn compatible_ts_merge_keeps_aud_tag_omits_faststart() {
        let merge = build_compatible_mpegts_concat_to_mp4_args(
            "list.txt",
            "out.mp4",
            VideoCodec::Hevc,
            true,
        );
        // AUD on merge so MP4 muxer can derive HEVC dimensions (Legacy parity).
        assert!(merge.contains(&"hevc_metadata=aud=insert".into()));
        assert!(merge.contains(&"hev1".into()));
        assert!(merge.contains(&"aac_adtstoasc".into()));
        assert!(
            !merge.iter().any(|a| a == "+faststart"),
            "Phase 43.1: Compatible join omits +faststart (separate finalize)"
        );

        let prep_mp4 = build_compatible_prep_mp4_concat_args(
            "list.txt",
            "out.mp4",
            VideoCodec::Hevc,
            true,
        );
        // Same stream args as prep-MP4 merge builder; both omit faststart.
        assert_eq!(merge, prep_mp4);
    }

    #[test]
    fn compatible_ts_segment_to_mp4_for_mkv_fallback() {
        let hevc = build_compatible_ts_segment_to_mp4_args(
            "seg.ts",
            "seg.mp4",
            VideoCodec::Hevc,
            true,
        );
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"hev1".into()));
        assert!(hevc.contains(&"aac_adtstoasc".into()));
        assert!(!hevc.iter().any(|a| a == "+faststart"));
        assert_eq!(hevc.last().unwrap(), "seg.mp4");
    }

    #[test]
    fn omit_faststart_movflags_removes_pair() {
        let mut args = vec![
            "-c".into(),
            "copy".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-progress".into(),
            "pipe:1".into(),
        ];
        omit_faststart_movflags(&mut args);
        assert!(!args.iter().any(|a| a == "+faststart"));
        assert!(!args.iter().any(|a| a == "-movflags"));
        assert!(args.contains(&"copy".into()));
        assert!(args.contains(&"pipe:1".into()));
    }

    #[test]
    fn omit_video_aud_insert_bsf_removes_pair() {
        let mut args = vec![
            "-c".into(),
            "copy".into(),
            "-bsf:v".into(),
            "h264_metadata=aud=insert".into(),
            "-tag:v".into(),
            "avc1".into(),
        ];
        omit_video_aud_insert_bsf(&mut args);
        assert!(!args.iter().any(|a| a.contains("aud=insert")));
        assert!(!args.iter().any(|a| a == "-bsf:v"));
        assert!(args.contains(&"avc1".into()));
    }

    #[test]
    fn mkv_remux_omits_aud_when_segment_already_hygiened() {
        // Phase 43.4: TS→MP4 already applied AUD; MKV→MP4 must not re-insert.
        let mut remux = build_remux_mkv_to_mp4_args(
            "in.mkv",
            "out.mp4",
            VideoCodec::Hevc,
            true,
            "hev1",
        );
        assert!(remux.contains(&"hevc_metadata=aud=insert".into()));
        omit_video_aud_insert_bsf(&mut remux);
        assert!(!remux.iter().any(|a| a.contains("aud=insert")));
        assert!(remux.contains(&"hev1".into()));
        assert!(remux.contains(&"aac_adtstoasc".into()));
    }

    #[test]
    fn compatible_should_validate_splice_policy() {
        // Dirty always; HEVC always; Clean H.264 skips unless force.
        assert!(compatible_should_validate_splice(
            true,
            VideoCodec::H264,
            false
        ));
        assert!(compatible_should_validate_splice(
            false,
            VideoCodec::Hevc,
            false
        ));
        assert!(compatible_should_validate_splice(
            true,
            VideoCodec::Hevc,
            false
        ));
        assert!(!compatible_should_validate_splice(
            false,
            VideoCodec::H264,
            false
        ));
        assert!(compatible_should_validate_splice(
            false,
            VideoCodec::H264,
            true
        ));
    }

    #[test]
    fn compatible_remux_prep_workers_ignore_hw() {
        assert_eq!(compatible_remux_prep_worker_count(1), 1);
        let n = compatible_remux_prep_worker_count(8);
        assert!((2..=4).contains(&n));
        assert_eq!(n, crate::video::probe::probe_worker_count(8));
    }

    #[test]
    fn prep_merge_hygiene_single_aud_layer() {
        // Prep = Annex-B only; Merge = AUD/tag once (no double insert).
        let prep = build_prep_compatible_to_mpegts_args(
            "in.mp4",
            "out.ts",
            VideoCodec::H264,
            true,
            true,
        );
        let merge = build_compatible_mpegts_concat_to_mp4_args(
            "list.txt",
            "out.mp4",
            VideoCodec::H264,
            true,
        );
        assert!(prep.contains(&"h264_mp4toannexb".into()));
        assert!(!prep.iter().any(|a| a.contains("aud=insert")));
        assert!(merge.contains(&"h264_metadata=aud=insert".into()));
        let aud_count = merge
            .iter()
            .filter(|a| a.contains("aud=insert"))
            .count();
        assert_eq!(aud_count, 1);
    }

    #[test]
    fn compatible_dirty_prep_dispatch_writes_ts() {
        let work = Path::new("/tmp/ats_compat_prep");
        let (out, args) = compatible_dirty_prep_plan(
            work,
            2,
            "clip.mp4",
            VideoCodec::H264,
            true,
        );
        assert_eq!(compatible_prep_segment_filename(2), "seg_2_compat.ts");
        assert!(
            out.extension().and_then(|e| e.to_str()) == Some("ts"),
            "dispatch must write .ts not intermediate .mp4"
        );
        assert!(out.to_string_lossy().contains("seg_2_compat.ts"));
        assert!(args.contains(&"mpegts".into()));
        assert!(args.contains(&"h264_mp4toannexb".into()));
        assert!(!args.iter().any(|a| a.contains("aud=insert")));
        assert!(!args.iter().any(|a| a.ends_with(".mp4") && a != "clip.mp4"));
        let expected = build_prep_compatible_to_mpegts_args(
            "clip.mp4",
            &path_str(&out),
            VideoCodec::H264,
            true,
            true,
        );
        assert_eq!(args, expected);
    }

    #[test]
    fn compatible_prep_progress_percent_scales() {
        assert!((compatible_prep_progress_percent(0, 4) - 0.0).abs() < 0.001);
        assert!((compatible_prep_progress_percent(2, 4) - 50.0).abs() < 0.001);
        assert!((compatible_prep_progress_percent(4, 4) - 100.0).abs() < 0.001);
        assert!((compatible_prep_progress_percent(0, 0) - 100.0).abs() < 0.001);
        assert_eq!(compatible_prep_status(3, 8), "compatible-prep:3/8");
    }

    #[test]
    fn compatible_finalize_faststart_args() {
        let with_a = build_compatible_finalize_faststart_args("in.mp4", "out.mp4", true);
        assert!(with_a.contains(&"+faststart".into()));
        assert!(with_a.contains(&"copy".into()));
        assert!(with_a.contains(&"0:v:0".into()));
        assert!(with_a.contains(&"0:a:0".into()));
        assert!(with_a.contains(&"-dn".into()));
        // Never `-map 0` (would copy GoPro/DJI timecode / data tracks).
        for (i, a) in with_a.iter().enumerate() {
            if a == "-map" {
                assert_ne!(with_a.get(i + 1).map(|s| s.as_str()), Some("0"));
            }
        }
        assert!(with_a.contains(&"pipe:1".into()));
        assert_eq!(with_a.last().unwrap(), "out.mp4");
        let i = with_a.iter().position(|a| a == "-i").unwrap();
        assert_eq!(with_a[i + 1], "in.mp4");

        let no_a = build_compatible_finalize_faststart_args("in.mp4", "out.mp4", false);
        assert!(no_a.contains(&"0:v:0".into()));
        assert!(!no_a.iter().any(|a| a == "0:a:0"));
    }

    #[test]
    fn compatible_mpegts_wrappers_match_shared_builders() {
        let ts = build_compatible_mp4_to_mpegts_args("a.mp4", "a.ts", VideoCodec::H264, true);
        let shared = build_mp4_to_mpegts_args("a.mp4", "a.ts", VideoCodec::H264, true);
        assert_eq!(ts, shared);

        let merge = build_compatible_mpegts_concat_to_mp4_args(
            "ts_list.txt",
            "out.mp4",
            VideoCodec::Hevc,
            true,
        );
        assert!(merge.contains(&"hevc_metadata=aud=insert".into()));
        assert!(merge.contains(&"hev1".into()));
        assert!(merge.contains(&"aac_adtstoasc".into()));
        assert!(!merge.iter().any(|a| a == "+faststart"));
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
        let args = build_mpegts_concat_to_mp4_args(
            "ts_list.txt",
            "out.mp4",
            VideoCodec::H264,
            true,
            "hev1",
        );
        assert!(args.contains(&"concat".into()));
        assert!(args.contains(&"-safe".into()));
        assert!(args.contains(&"0".into()));
        assert!(args.contains(&"ts_list.txt".into()));
        assert!(args.contains(&"h264_metadata=aud=insert".into()));
        assert!(args.contains(&"avc1".into()));
        assert!(args.contains(&"aac_adtstoasc".into()));
        assert_eq!(args.last().unwrap(), "out.mp4");

        let hevc = build_mpegts_concat_to_mp4_args(
            "ts_list.txt",
            "out.mp4",
            VideoCodec::Hevc,
            true,
            "hev1",
        );
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"hev1".into()));
        assert!(!hevc.iter().any(|a| a.starts_with("concat:")));
    }

    #[test]
    fn concat_demuxer_copy_and_reencode() {
        let copy = build_concat_demuxer_copy_args("list.txt", "out.mp4", true);
        assert!(copy.contains(&"concat".into()));
        assert!(copy.contains(&"copy".into()));

        let params = EncodingParams::software();
        let re = build_concat_demuxer_reencode_args("list.txt", "out.mp4", &params, false);
        assert!(re.contains(&"libx264".into()));
        assert!(re.contains(&"aac".into()));
        let re_copy = build_concat_demuxer_reencode_args("list.txt", "out.mp4", &params, true);
        assert!(re_copy.contains(&"copy".into()));
        assert!(!re_copy.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
    }

    #[test]
    fn fast_body_concat_mode_aliases() {
        assert!(is_fast_body_concat_mode("fast"));
        assert!(is_fast_body_concat_mode("fast_path"));
        assert!(is_fast_body_concat_mode("FAST"));
        assert!(!is_fast_body_concat_mode("legacy"));
        assert!(!is_fast_body_concat_mode("compatible"));
        assert!(!is_fast_body_concat_mode("avidemux"));
        assert!(!is_fast_body_concat_mode(""));
    }

    #[test]
    fn compatible_body_concat_mode_aliases() {
        assert!(is_compatible_body_concat_mode("compatible"));
        assert!(is_compatible_body_concat_mode("compat"));
        assert!(is_compatible_body_concat_mode("qt_safe"));
        assert!(is_compatible_body_concat_mode("prepared"));
        assert!(is_compatible_body_concat_mode("avidemux"));
        assert!(is_compatible_body_concat_mode("COMPATIBLE"));
        assert!(!is_compatible_body_concat_mode("fast"));
        assert!(!is_compatible_body_concat_mode("legacy"));
        assert!(!is_compatible_body_concat_mode(""));
    }

    #[test]
    fn probing_progress_skipped_on_cache_hit() {
        assert!(!should_emit_probing_progress(true));
        assert!(should_emit_probing_progress(false));
    }

    #[test]
    fn compatible_probe_progress_skipped_on_cache_hit() {
        assert!(!should_emit_compatible_probe_progress(true, true, 4));
        assert!(should_emit_compatible_probe_progress(true, false, 4));
        assert!(!should_emit_compatible_probe_progress(true, false, 1));
        assert!(!should_emit_compatible_probe_progress(false, false, 4));
    }

    #[test]
    fn clip_concat_probe_from_cache_matches_gate_keys() {
        let stderr = r#"
Input #0, mov, from 'a.mp4':
  Duration: 00:00:08.00, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo
"#;
        let cached = probe_cache::cached_probe_from_stderr(stderr).unwrap();
        let probe = ClipConcatProbe::from_cached(&cached);
        assert_eq!(probe.vcodec, VideoCodec::H264);
        assert!(probe.has_audio);
        assert!((probe.duration_secs - 8.0).abs() < 0.01);
        compatible_probe_gate_keys(
            &[probe.compatible_key.clone(), probe.compatible_key.clone()],
            true,
        )
        .unwrap();
    }

    #[test]
    fn parse_audio_codec_from_probe_aac() {
        let stderr = "  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo";
        let (c, r) = parse_audio_codec_from_probe(stderr).unwrap();
        assert_eq!(c, "aac");
        assert_eq!(r, "48000");
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
        assert!(args.contains(&"-skip_frame".into()));
        assert!(args.contains(&"nokey".into()));
        assert!(args.iter().any(|a| a.contains("showinfo")));
        assert!(!args.contains(&"-vsync".into()));

        let legacy = build_keyframe_scan_args_pict_type("in.mp4", 10.0);
        assert!(legacy.iter().any(|a| a.contains("pict_type")));
    }

    #[test]
    fn parse_keyframe_times_skip_frame_pts_only() {
        let stderr = r#"
[Parsed_showinfo_0 @ 0x1] n:0 pts:0 pts_time:0.000000
[Parsed_showinfo_0 @ 0x1] n:1 pts:90000 pts_time:2.000000
"#;
        let times = parse_keyframe_times(stderr);
        assert_eq!(times, vec![0.0, 2.0]);
        assert!((keyframe_at_or_after(&times, 1.0).unwrap() - 2.0).abs() < 0.001);
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
    fn compatible_clips_are_clean_predicate() {
        use crate::video::probe::VideoRotationProbe;

        fn key(
            codec: &str,
            tag: &str,
            rot: VideoRotationProbe,
            editlist: bool,
        ) -> CompatibleStreamKey {
            CompatibleStreamKey {
                codec: codec.into(),
                width: 1920,
                height: 1080,
                pix_fmt: "yuv420p".into(),
                tag: tag.into(),
                profile: "High".into(),
                has_audio: true,
                rotation: rot,
                needs_editlist_hygiene: editlist,
            }
        }

        assert!(!compatible_clips_are_clean(&[]));

        let clean_h264 = key("h264", "avc1", VideoRotationProbe::Known(0), false);
        assert!(compatible_clips_are_clean(&[
            clean_h264.clone(),
            clean_h264.clone()
        ]));

        let clean_hevc = key("hevc", "hvc1", VideoRotationProbe::Known(0), false);
        assert!(compatible_clips_are_clean(&[clean_hevc]));

        let rotated = key("h264", "avc1", VideoRotationProbe::Known(180), false);
        assert!(!compatible_clips_are_clean(&[rotated]));

        let editlist = key("h264", "avc1", VideoRotationProbe::Known(0), true);
        assert!(!compatible_clips_are_clean(&[editlist]));

        let exotic = key("hevc", "dvh1", VideoRotationProbe::Known(0), false);
        assert!(!compatible_clips_are_clean(&[exotic]));

        assert!(compatible_tag_allows_clean_pass("h264", ""));
        assert!(compatible_tag_allows_clean_pass("h264", "avc1"));
        assert!(!compatible_tag_allows_clean_pass("h264", "encv"));
        assert!(compatible_tag_allows_clean_pass("hevc", "hev1"));
        assert!(!compatible_tag_allows_clean_pass("vp9", "vp09"));
    }

    #[test]
    fn compatible_clean_concat_args_hygiene_no_faststart() {
        let h264 = build_compatible_clean_concat_args(
            "list.txt",
            "out.mp4",
            VideoCodec::H264,
            true,
        );
        assert!(h264.contains(&"concat".into()));
        assert!(h264.contains(&"copy".into()));
        assert!(h264.contains(&"h264_metadata=aud=insert".into()));
        assert!(h264.contains(&"avc1".into()));
        assert!(h264.contains(&"make_zero".into()));
        assert!(!h264.iter().any(|a| a == "+faststart"));
        assert_eq!(h264.last().unwrap(), "out.mp4");

        let hevc = build_compatible_clean_concat_args(
            "list.txt",
            "out.mp4",
            VideoCodec::Hevc,
            false,
        );
        assert!(hevc.contains(&"hevc_metadata=aud=insert".into()));
        assert!(hevc.contains(&"hev1".into()));
        assert!(!hevc.iter().any(|a| a == "0:a:0?"));
        assert!(!hevc.iter().any(|a| a == "+faststart"));
    }

    #[test]
    fn hevc_tag_default() {
        assert_eq!(hevc_stream_copy_video_tag(), "hev1");
    }
}
