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

    Ok(VideoMetadata {
        path: input.to_string(),
        filename,
        duration_secs,
        width: parsed.width,
        height: parsed.height,
        codec: parsed.codec,
        fps: parsed.fps,
        size_bytes,
    })
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
}
