//! Probe video metadata via `ffmpeg -i` stderr (no ffprobe required).

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use super::ffmpeg::{ffmpeg_probe_stderr, FfmpegError};
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
    raw.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

/// Compact label for UI / logs, e.g. `"DJI OsmoAction4"`. `None` if both empty.
pub fn format_camera_label(make: &str, model: &str) -> Option<String> {
    let make = make.trim();
    let model = model.trim();
    if make.is_empty() && model.is_empty() {
        return None;
    }
    if make.is_empty() {
        return Some(model.to_string());
    }
    if model.is_empty() {
        return Some(make.to_string());
    }
    if model.to_ascii_lowercase().starts_with(&make.to_ascii_lowercase()) {
        Some(model.to_string())
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
    }
}
