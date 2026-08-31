//! Probe video metadata via `ffmpeg -i` stderr (no ffprobe required).

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use std::sync::atomic::{AtomicUsize, Ordering};

use super::ffmpeg::{ffmpeg_probe_stderr, is_cancelled, FfmpegError};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::progress::parse_duration;

static VIDEO_META_RE: Lazy<Regex> = Lazy::new(|| {
    // Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps, ...
    // Stream #0:0(eng): Video: hevc (Main), yuv420p(tv, bt709), 3840x2160 [SAR 1:1 DAR 16:9], 59.94 fps, ...
    // Stream #0:0[0x1](und): Video: h264 (Baseline) ..., 832x464, ...  (modern FFmpeg)
    Regex::new(
        r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Video:\s+(\w+).*?(\d{2,5})x(\d{2,5})",
    )
    .unwrap()
});

static FPS_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(?:,|\s)(\d+(?:\.\d+)?)\s*fps").unwrap());

static PIX_FMT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Video:\s+\w+[^,]*,\s*([a-z0-9]+)").unwrap());

static VIDEO_TAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Video:\s+\w+.*?\((\w+)\s*/\s*0x[0-9a-f]+\)").unwrap()
});

static PROFILE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)Video:\s+\w+\s+\(([^)/]+)\)").unwrap()
});

/// `rotate : 180` / `rotate: 90` container or stream metadata tags.
static ROTATE_TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^\s*rotate\s*:\s*(-?\d+(?:\.\d+)?)\s*$").unwrap());

/// `displaymatrix: rotation of -90.00 degrees` (stream side data).
static DISPLAYMATRIX_ROT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)displaymatrix:\s*rotation\s+of\s+(-?\d+(?:\.\d+)?)\s+degrees").unwrap()
});

/// Tolerance when snapping probe angles to quarter turns (degrees).
const ROTATION_SNAP_TOLERANCE_DEG: f64 = 1.0;

/// Container metadata keys written by many cameras (MP4/MOV).
/// Prefer explicit make/model; ignore `encoder` (usually Lavf / app software).
static CAMERA_TAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?im)^\s*(?:com\.apple\.quicktime\.)?(make|model|manufacturer)\s*:\s*(.+?)\s*$",
    )
    .unwrap()
});

#[derive(Debug, Clone, Serialize)]
pub struct VideoMetadata {
    pub path: String,
    pub filename: String,
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    /// Approximate FPS when parsed from the stream line; 0 if unknown.
    pub fps: f64,
    pub size_bytes: u64,
    /// Camera / device brand from container metadata (empty if unknown).
    pub camera_make: String,
    /// Camera / device model from container metadata (empty if unknown).
    pub camera_model: String,
}

/// Probe a single video file for duration, resolution, and codec.
pub fn probe_video(ffmpeg: &Path, input: &str) -> Result<VideoMetadata, FfmpegError> {
    let path = Path::new(input);
    if !path.is_file() {
        return Err(FfmpegError::Message(format!("file not found: {input}")));
    }

    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    let parsed = parse_video_metadata_from_probe(&stderr).ok_or_else(|| {
        FfmpegError::Message(format!("could not parse video stream from: {input}"))
    })?;

    let duration_secs = parse_duration(&stderr).unwrap_or(0.0);
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(input)
        .to_string();
    let (camera_make, camera_model) = parse_camera_from_probe(&stderr);

    Ok(VideoMetadata {
        path: input.to_string(),
        filename,
        duration_secs,
        width: parsed.width,
        height: parsed.height,
        codec: parsed.codec,
        fps: parsed.fps,
        size_bytes,
        camera_make,
        camera_model,
    })
}

/// Parse camera make/model from FFmpeg `-i` stderr metadata lines.
pub fn parse_camera_from_probe(stderr: &str) -> (String, String) {
    let mut make = String::new();
    let mut model = String::new();
    for caps in CAMERA_TAG_RE.captures_iter(stderr) {
        let key = caps.get(1).map(|m| m.as_str().to_ascii_lowercase()).unwrap_or_default();
        let val = caps
            .get(2)
            .map(|m| sanitize_meta_value(m.as_str()))
            .unwrap_or_default();
        if val.is_empty() {
            continue;
        }
        match key.as_str() {
            "make" | "manufacturer" => {
                if make.is_empty() {
                    make = val;
                }
            }
            "model" => {
                if model.is_empty() {
                    model = val;
                }
            }
            _ => {}
        }
    }
    (make, model)
}

fn sanitize_meta_value(raw: &str) -> String {
    crate::media::datetime::sanitize_camera_text(raw)
}

/// Compact label for UI / logs, e.g. `"DJI OsmoAction4"`. `None` if both empty.
pub fn format_camera_label(make: &str, model: &str) -> Option<String> {
    let make = sanitize_meta_value(make);
    let model = sanitize_meta_value(model);
    if make.is_empty() && model.is_empty() {
        return None;
    }
    if make.is_empty() {
        return Some(model);
    }
    if model.is_empty() {
        return Some(make);
    }
    if model.to_ascii_lowercase().starts_with(&make.to_ascii_lowercase()) {
        Some(model)
    } else {
        Some(format!("{make} {model}"))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedStreamMeta {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// Comparison key for Compatible body-concat probe gate (Phase 40.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibleStreamKey {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: String,
    /// Container fourcc when present (`avc1`, `hev1`, `hvc1`, …); empty if unknown.
    pub tag: String,
    /// Best-effort profile label (`High`, `Main`, …); empty if unknown.
    pub profile: String,
    pub has_audio: bool,
    /// Soft-rotation probe result (displaymatrix / `rotate` tag / side data).
    pub rotation: VideoRotationProbe,
}

/// Result of probing soft rotation from FFmpeg stderr (Phase 40.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoRotationProbe {
    /// No rotation metadata or explicit 0° — treat as upright.
    Known(u32),
    /// Non-orthogonal or unparseable angle — gate must fail conservatively.
    Unknown { raw_deg: i32 },
    /// `displaymatrix` and `rotate` tag disagree after normalization.
    Conflict {
        displaymatrix_deg: u32,
        tag_deg: u32,
    },
}

impl VideoRotationProbe {
    /// Canonical degrees when known; `None` when probe is unreliable.
    pub fn known_degrees(self) -> Option<u32> {
        match self {
            Self::Known(deg) => Some(deg),
            Self::Unknown { .. } | Self::Conflict { .. } => None,
        }
    }
}

/// Parse codec + resolution (+ optional fps) from FFmpeg probe stderr.
pub fn parse_video_metadata_from_probe(stderr: &str) -> Option<ParsedStreamMeta> {
    let caps = VIDEO_META_RE.captures(stderr)?;
    let codec = caps.get(1)?.as_str().to_lowercase();
    let width: u32 = caps.get(2)?.as_str().parse().ok()?;
    let height: u32 = caps.get(3)?.as_str().parse().ok()?;

    let fps = FPS_RE
        .captures(stderr)
        .and_then(|c| c.get(1)?.as_str().parse::<f64>().ok())
        .unwrap_or(0.0);

    Some(ParsedStreamMeta {
        codec,
        width,
        height,
        fps,
    })
}

/// Pixel format from the first video stream line (`yuv420p`, …).
pub fn parse_pix_fmt_from_probe(stderr: &str) -> Option<String> {
    PIX_FMT_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
}

/// Unified soft-rotation probe for Compatible path (Phase 40.2).
///
/// Prefers `displaymatrix` side-data over the `rotate` metadata tag.
/// Missing metadata → `Known(0)`. Non-quarter angles → `Unknown` (conservative).
pub fn probe_video_rotation_degrees(stderr: &str) -> VideoRotationProbe {
    let dm_raw = parse_displaymatrix_rotation_raw(stderr);
    let tag_raw = parse_rotate_tag_raw(stderr);

    let dm = dm_raw.and_then(snap_rotation_degrees_f64);
    let tag = tag_raw.and_then(snap_rotation_degrees_f64);

    if let Some(raw) = dm_raw {
        if dm.is_none() {
            return VideoRotationProbe::Unknown {
                raw_deg: raw.round() as i32,
            };
        }
    }
    if let Some(raw) = tag_raw {
        if tag.is_none() {
            return VideoRotationProbe::Unknown {
                raw_deg: raw.round() as i32,
            };
        }
    }

    match (dm, tag) {
        (Some(d), Some(t)) if d != t => VideoRotationProbe::Conflict {
            displaymatrix_deg: d,
            tag_deg: t,
        },
        (Some(d), _) => VideoRotationProbe::Known(d),
        (None, Some(t)) => VideoRotationProbe::Known(t),
        (None, None) => VideoRotationProbe::Known(0),
    }
}

/// Soft-rotation in degrees when reliably known (`{0,90,180,270}`).
///
/// Returns `None` when metadata is absent, ambiguous, or conflicting.
pub fn parse_video_rotation_degrees(stderr: &str) -> Option<u32> {
    probe_video_rotation_degrees(stderr).known_degrees()
}

fn parse_displaymatrix_rotation_raw(stderr: &str) -> Option<f64> {
    DISPLAYMATRIX_ROT_RE
        .captures(stderr)
        .and_then(|caps| caps.get(1)?.as_str().parse().ok())
}

fn parse_rotate_tag_raw(stderr: &str) -> Option<f64> {
    ROTATE_TAG_RE
        .captures(stderr)
        .and_then(|caps| caps.get(1)?.as_str().parse().ok())
}

fn snap_rotation_degrees_f64(raw: f64) -> Option<u32> {
    let mut deg = raw.round() as i32 % 360;
    if deg < 0 {
        deg += 360;
    }
    for &candidate in &[0u32, 90, 180, 270] {
        let diff = (deg - candidate as i32).unsigned_abs();
        let diff = diff.min(360 - diff);
        if f64::from(diff) <= ROTATION_SNAP_TOLERANCE_DEG {
            return Some(candidate);
        }
    }
    None
}

/// i18n-ready technical reason when a clip's orientation cannot be trusted.
pub fn compatible_orientation_unreliable_reason(probe: VideoRotationProbe, clip_index: usize) -> Option<String> {
    match probe {
        VideoRotationProbe::Known(_) => None,
        VideoRotationProbe::Unknown { raw_deg } => Some(format!(
            "compatible.orientation_unknown:raw={raw_deg}:clip={clip_index}"
        )),
        VideoRotationProbe::Conflict {
            displaymatrix_deg,
            tag_deg,
        } => Some(format!(
            "compatible.orientation_conflict:displaymatrix={displaymatrix_deg}:tag={tag_deg}:clip={clip_index}"
        )),
    }
}

/// i18n-ready technical reason when clips disagree on soft rotation.
pub fn compatible_orientation_mismatch_reason(
    deg_a: u32,
    clip_b_index: usize,
    deg_b: u32,
) -> String {
    format!("compatible.orientation_mismatch:{deg_a}:{deg_b}:clip1:clip{clip_b_index}")
}

/// Build a Compatible probe key from one clip's FFmpeg `-i` stderr.
pub fn compatible_stream_key_from_probe(stderr: &str, has_audio: bool) -> Option<CompatibleStreamKey> {
    let meta = parse_video_metadata_from_probe(stderr)?;
    let pix_fmt = parse_pix_fmt_from_probe(stderr).unwrap_or_default();
    let tag = VIDEO_TAG_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        .unwrap_or_default();
    let profile = PROFILE_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_default();
    let rotation = probe_video_rotation_degrees(stderr);
    Some(CompatibleStreamKey {
        codec: meta.codec,
        width: meta.width,
        height: meta.height,
        pix_fmt,
        tag,
        profile,
        has_audio,
        rotation,
    })
}

/// True when two clips are Compatible-mergeable (same geometry/codec/pix_fmt/audio/rotation).
///
/// Tag/profile are best-effort and ignored when either side is empty so older probes still pass.
/// Rotation must be reliably known and equal on both sides.
pub fn compatible_stream_keys_match(a: &CompatibleStreamKey, b: &CompatibleStreamKey) -> bool {
    let rot_a = a.rotation.known_degrees();
    let rot_b = b.rotation.known_degrees();
    if a.codec != b.codec
        || a.width != b.width
        || a.height != b.height
        || a.pix_fmt != b.pix_fmt
        || a.has_audio != b.has_audio
        || rot_a.is_none()
        || rot_b.is_none()
        || rot_a != rot_b
    {
        return false;
    }
    if !a.tag.is_empty() && !b.tag.is_empty() && a.tag != b.tag {
        return false;
    }
    if !a.profile.is_empty() && !b.profile.is_empty() && a.profile != b.profile {
        return false;
    }
    true
}

/// Worker count for parallel import probe (CPU-only, 2–4 when multiple files).
pub fn probe_worker_count(file_count: usize) -> usize {
    if file_count <= 1 {
        return 1;
    }
    let cpu = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    cpu.clamp(2, 4)
}

/// Probe multiple videos in parallel; results match `paths` order (one entry per path).
pub fn probe_videos_parallel(
    ffmpeg: &Path,
    paths: &[String],
    on_progress: impl Fn(u64, u64, &str) + Sync + Send,
) -> Result<Vec<Result<VideoMetadata, String>>, ParallelError> {
    let ffmpeg = ffmpeg.to_path_buf();
    probe_videos_parallel_with(paths, move |path| probe_video(&ffmpeg, path).map_err(|e| e.to_string()), on_progress)
}

fn probe_videos_parallel_with<P, F>(
    paths: &[String],
    probe_one: P,
    on_progress: F,
) -> Result<Vec<Result<VideoMetadata, String>>, ParallelError>
where
    P: Fn(&str) -> Result<VideoMetadata, String> + Sync + Send,
    F: Fn(u64, u64, &str) + Sync + Send,
{
    let n = paths.len();
    if n == 0 {
        return Ok(Vec::new());
    }

    let workers = probe_worker_count(n);
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(2);
    let pool = ParallelVideoProcessor {
        max_workers: workers,
        hw_accel_enabled: false,
        cpu_count,
    };

    let paths: Vec<String> = paths.to_vec();
    let completed = AtomicUsize::new(0);
    let total = n as u64;

    pool.process_indexed(n, |i, _task_id| {
        if is_cancelled() {
            return Err("cancelled".into());
        }
        let path = paths[i].as_str();
        let result = probe_one(path);
        let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
        let name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);
        on_progress(done as u64, total, name);
        result
    }, None)
}

/// Common video extensions accepted for import (case-insensitive).
pub fn is_video_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mp4" | "mov" | "mkv" | "avi" | "m4v" | "webm" | "mts" | "m2ts"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_h264_1080p() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test.mp4':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 7970 kb/s, 30 fps, 30 tbr, 90k tbn
"#;
        let meta = parse_video_metadata_from_probe(stderr).unwrap();
        assert_eq!(meta.codec, "h264");
        assert_eq!(meta.width, 1920);
        assert_eq!(meta.height, 1080);
        assert!((meta.fps - 30.0).abs() < 0.01);
    }

    #[test]
    fn parse_hevc_4k() {
        let stderr = "  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160 [SAR 1:1 DAR 16:9], 59.94 fps, 59.94 tbr";
        let meta = parse_video_metadata_from_probe(stderr).unwrap();
        assert_eq!(meta.codec, "hevc");
        assert_eq!(meta.width, 3840);
        assert_eq!(meta.height, 2160);
        assert!((meta.fps - 59.94).abs() < 0.01);
    }

    #[test]
    fn parse_modern_ffmpeg_stream_id() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '0_qr_neu.mp4':
  Duration: 00:00:06.78, start: 0.000000, bitrate: 1531 kb/s
  Stream #0:0[0x1](und): Video: h264 (Baseline) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 832x464, 1478 kb/s, 30.01 fps, 30 tbr, 600 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 59 kb/s (default)
"#;
        let meta = parse_video_metadata_from_probe(stderr).unwrap();
        assert_eq!(meta.codec, "h264");
        assert_eq!(meta.width, 832);
        assert_eq!(meta.height, 464);
        assert!((meta.fps - 30.01).abs() < 0.01);
    }

    #[test]
    fn probe_rotation_from_displaymatrix_and_tag() {
        let dm = "      Side data:\n        displaymatrix: rotation of -90.00 degrees\n";
        assert_eq!(
            probe_video_rotation_degrees(dm),
            VideoRotationProbe::Known(270)
        );
        assert_eq!(parse_video_rotation_degrees(dm), Some(270));

        let tag = "  Metadata:\n    rotate          : 180\n";
        assert_eq!(
            probe_video_rotation_degrees(tag),
            VideoRotationProbe::Known(180)
        );

        assert_eq!(
            probe_video_rotation_degrees("no rotation here"),
            VideoRotationProbe::Known(0)
        );
    }

    #[test]
    fn probe_rotation_uses_displaymatrix_when_tag_absent() {
        let stderr = r#"
      Side data:
        displaymatrix: rotation of -90.00 degrees
"#;
        assert_eq!(
            probe_video_rotation_degrees(stderr),
            VideoRotationProbe::Known(270)
        );
    }

    #[test]
    fn probe_rotation_conflict_is_conservative() {
        let stderr = r#"
      Side data:
        displaymatrix: rotation of 90.00 degrees
  Metadata:
    rotate          : 180
"#;
        assert_eq!(
            probe_video_rotation_degrees(stderr),
            VideoRotationProbe::Conflict {
                displaymatrix_deg: 90,
                tag_deg: 180,
            }
        );
        assert_eq!(parse_video_rotation_degrees(stderr), None);
    }

    #[test]
    fn probe_rotation_unknown_non_quarter_angle() {
        let stderr = "  Metadata:\n    rotate          : 45\n";
        assert_eq!(
            probe_video_rotation_degrees(stderr),
            VideoRotationProbe::Unknown { raw_deg: 45 }
        );
    }

    #[test]
    fn compatible_orientation_reason_strings() {
        assert_eq!(
            compatible_orientation_mismatch_reason(0, 2, 180).as_str(),
            "compatible.orientation_mismatch:0:180:clip1:clip2"
        );
        assert_eq!(
            compatible_orientation_unreliable_reason(
                VideoRotationProbe::Unknown { raw_deg: 45 },
                1
            )
            .as_deref(),
            Some("compatible.orientation_unknown:raw=45:clip=1")
        );
        assert_eq!(
            compatible_orientation_unreliable_reason(
                VideoRotationProbe::Conflict {
                    displaymatrix_deg: 90,
                    tag_deg: 180,
                },
                3
            )
            .as_deref(),
            Some("compatible.orientation_conflict:displaymatrix=90:tag=180:clip=3")
        );
    }

    #[test]
    fn compatible_stream_key_matches_and_rejects_mismatch() {
        let stderr_a = r#"
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
  Metadata:
    rotate          : 0
"#;
        let stderr_b = r#"
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
"#;
        let a = compatible_stream_key_from_probe(stderr_a, true).unwrap();
        let b = compatible_stream_key_from_probe(stderr_b, true).unwrap();
        assert_eq!(a.rotation, VideoRotationProbe::Known(0));
        assert_eq!(b.rotation, VideoRotationProbe::Known(0));
        assert!(compatible_stream_keys_match(&a, &b));

        let stderr_rot = r#"
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
  Metadata:
    rotate          : 180
"#;
        let c = compatible_stream_key_from_probe(stderr_rot, true).unwrap();
        assert_eq!(c.rotation, VideoRotationProbe::Known(180));
        assert!(!compatible_stream_keys_match(&a, &c));

        let stderr_unknown = r#"
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
  Metadata:
    rotate          : 45
"#;
        let u = compatible_stream_key_from_probe(stderr_unknown, true).unwrap();
        assert!(!compatible_stream_keys_match(&a, &u));

        let stderr_sz = r#"
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720, 30 fps
"#;
        let d = compatible_stream_key_from_probe(stderr_sz, true).unwrap();
        assert!(!compatible_stream_keys_match(&a, &d));
    }

    #[test]
    fn is_video_path_filters() {
        assert!(is_video_path(r"C:\a\clip.MP4"));
        assert!(is_video_path("photo.mov"));
        assert!(!is_video_path("photo.jpg"));
        assert!(!is_video_path("readme.txt"));
    }

    #[test]
    fn parse_camera_quicktime_tags() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Metadata:
    major_brand     : qt  
    encoder         : Lavf58.76.100
    com.apple.quicktime.make: DJI
    com.apple.quicktime.model: OsmoAction4
  Stream #0:0(eng): Video: hevc (Main), yuv420p, 1920x1080, 59.94 fps
"#;
        let (make, model) = parse_camera_from_probe(stderr);
        assert_eq!(make, "DJI");
        assert_eq!(model, "OsmoAction4");
        assert_eq!(
            format_camera_label(&make, &model).as_deref(),
            Some("DJI OsmoAction4")
        );
    }

    #[test]
    fn parse_camera_plain_make_model() {
        let stderr = r#"
  Metadata:
    make            : GoPro
    model           : HERO11 Black
  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps
"#;
        let (make, model) = parse_camera_from_probe(stderr);
        assert_eq!(make, "GoPro");
        assert_eq!(model, "HERO11 Black");
    }

    #[test]
    fn format_camera_label_dedupes_make_prefix() {
        assert_eq!(
            format_camera_label("DJI", "DJI FC3582").as_deref(),
            Some("DJI FC3582")
        );
        assert_eq!(format_camera_label("", "").as_deref(), None);
        assert_eq!(format_camera_label("Sony", "").as_deref(), Some("Sony"));
        assert_eq!(
            format_camera_label("\"\", \"\", \"\"", "\"\"").as_deref(),
            None
        );
        assert_eq!(
            format_camera_label("\"GoPro\"", "\"HERO11 Black\"").as_deref(),
            Some("GoPro HERO11 Black")
        );
    }

    #[test]
    fn parse_camera_ignores_empty_quoted_probe_values() {
        let stderr = "\n  Metadata:\n    make            : \"\", \"\", \"\"\n    model           : \"\"\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps\n";
        let (make, model) = parse_camera_from_probe(stderr);
        assert_eq!(make, "");
        assert_eq!(model, "");
        assert_eq!(format_camera_label(&make, &model).as_deref(), None);
    }

    #[test]
    fn probe_worker_count_clamped() {
        assert_eq!(probe_worker_count(0), 1);
        assert_eq!(probe_worker_count(1), 1);
        assert!(probe_worker_count(10) >= 2);
        assert!(probe_worker_count(10) <= 4);
    }

    #[test]
    fn probe_videos_parallel_preserves_input_order() {
        let paths: Vec<String> = (0..8)
            .map(|i| format!(r"C:\clips\clip_{i:02}.mp4"))
            .collect();
        let results = probe_videos_parallel_with(
            &paths,
            |path| {
                let idx = path
                    .rsplit('_')
                    .next()
                    .and_then(|s| s.strip_suffix(".mp4"))
                    .and_then(|s| s.parse::<usize>().ok())
                    .ok_or_else(|| "bad path".to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(5));
                Ok(VideoMetadata {
                    path: path.to_string(),
                    filename: format!("clip_{idx:02}.mp4"),
                    duration_secs: idx as f64,
                    width: 1920,
                    height: 1080,
                    codec: "h264".into(),
                    fps: 30.0,
                    size_bytes: 0,
                    camera_make: String::new(),
                    camera_model: String::new(),
                })
            },
            |_done, _total, _name| {},
        )
        .unwrap();

        assert_eq!(results.len(), paths.len());
        for (i, r) in results.iter().enumerate() {
            let meta = r.as_ref().expect("probe should succeed");
            assert_eq!(meta.path, paths[i]);
            assert!((meta.duration_secs - i as f64).abs() < f64::EPSILON);
        }
    }
}
