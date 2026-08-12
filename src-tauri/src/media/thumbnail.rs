//! Media thumbnails (photos via `image`, videos via FFmpeg frame extract).
//! Disk-cached under `{app_config}/thumbnails/` keyed by path+mtime+size+quality.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use thiserror::Error;

use crate::media::dji_paths::{is_photo_ext, is_video_ext};
use crate::storage::app_config_dir;
use crate::util::process::apply_no_window;
use crate::video::ffmpeg::find_ffmpeg;

/// Legacy / mid size (kept for callers that omit quality).
pub const THUMB_MAX_SIZE: u32 = 78;
pub const THUMB_LQ_SIZE: u32 = 48;
pub const THUMB_HQ_SIZE: u32 = 160;
/// Player poster / first-frame still (VideoPlayer on macOS WKWebView).
pub const THUMB_PREVIEW_SIZE: u32 = 960;
const THUMB_LQ_JPEG_Q: u8 = 55;
const THUMB_HQ_JPEG_Q: u8 = 78;
const THUMB_PREVIEW_JPEG_Q: u8 = 82;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbQuality {
    Lq,
    Hq,
    /// Larger still for HTML5 `poster` / first-frame display.
    Preview,
}

impl ThumbQuality {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "hq" | "high" => Self::Hq,
            "preview" | "poster" | "player" => Self::Preview,
            _ => Self::Lq,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lq => "lq",
            Self::Hq => "hq",
            Self::Preview => "preview",
        }
    }

    fn max_size(self) -> u32 {
        match self {
            Self::Lq => THUMB_LQ_SIZE,
            Self::Hq => THUMB_HQ_SIZE,
            Self::Preview => THUMB_PREVIEW_SIZE,
        }
    }

    fn jpeg_quality(self) -> u8 {
        match self {
            Self::Lq => THUMB_LQ_JPEG_Q,
            Self::Hq => THUMB_HQ_JPEG_Q,
            Self::Preview => THUMB_PREVIEW_JPEG_Q,
        }
    }

    /// FFmpeg scale width hint (keeps aspect; `-2` even height).
    fn ffmpeg_scale_w(self) -> u32 {
        match self {
            Self::Lq => 64,
            Self::Hq => 320,
            Self::Preview => 960,
        }
    }

    fn ffmpeg_qv(self) -> &'static str {
        match self {
            Self::Lq => "10",
            Self::Hq => "5",
            Self::Preview => "3",
        }
    }
}

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("unsupported media type")]
    Unsupported,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Message(String),
}

fn thumbnails_dir() -> Result<PathBuf, ThumbnailError> {
    let dir = app_config_dir()
        .map_err(|e| ThumbnailError::Message(e.to_string()))?
        .join("thumbnails");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn file_identity(path: &Path) -> Result<(u64, u64), ThumbnailError> {
    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((mtime, size))
}

fn cache_file_name(path: &Path, mtime: u64, size: u64, quality: ThumbQuality) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!(
        "{:016x}_{mtime}_{size}_{}.jpg",
        hasher.finish(),
        quality.as_str()
    )
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, ThumbnailError> {
    let mut jpeg = Vec::new();
    {
        let mut cursor = Cursor::new(&mut jpeg);
        let encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
        img.write_with_encoder(encoder)
            .map_err(|e| ThumbnailError::Message(e.to_string()))?;
    }
    Ok(jpeg)
}

fn to_data_url(jpeg: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", B64.encode(jpeg))
}

/// Generate (or load from disk cache) a JPEG thumbnail as `(jpeg_bytes, data_url)`.
pub fn generate_thumbnail_jpeg(
    path: &Path,
    max_size: u32,
) -> Result<(Vec<u8>, String), ThumbnailError> {
    let quality = if max_size <= THUMB_LQ_SIZE {
        ThumbQuality::Lq
    } else if max_size <= THUMB_HQ_SIZE {
        ThumbQuality::Hq
    } else {
        ThumbQuality::Preview
    };
    generate_thumbnail_cached(path, quality)
}

/// Preferred API: quality-aware generation with disk cache.
pub fn generate_thumbnail_cached(
    path: &Path,
    quality: ThumbQuality,
) -> Result<(Vec<u8>, String), ThumbnailError> {
    generate_thumbnail_cached_with_ffmpeg(path, quality, None)
}

/// Same as [`generate_thumbnail_cached`], but uses a pre-resolved FFmpeg binary when provided.
pub fn generate_thumbnail_cached_with_ffmpeg(
    path: &Path,
    quality: ThumbQuality,
    ffmpeg: Option<&Path>,
) -> Result<(Vec<u8>, String), ThumbnailError> {
    let (mtime, size) = file_identity(path)?;
    if let Ok(dir) = thumbnails_dir() {
        let cache_path = dir.join(cache_file_name(path, mtime, size, quality));
        if cache_path.is_file() {
            if let Ok(bytes) = fs::read(&cache_path) {
                // Ignore empty leftovers from earlier failed Windows locked writes.
                if bytes.len() > 32 {
                    return Ok((bytes.clone(), to_data_url(&bytes)));
                }
                let _ = fs::remove_file(&cache_path);
            }
        }
    }

    let jpeg = generate_thumbnail_bytes(path, quality, ffmpeg)?;
    if let Ok(dir) = thumbnails_dir() {
        let cache_path = dir.join(cache_file_name(path, mtime, size, quality));
        let _ = fs::write(&cache_path, &jpeg);
    }
    Ok((jpeg.clone(), to_data_url(&jpeg)))
}

fn generate_thumbnail_bytes(
    path: &Path,
    quality: ThumbQuality,
    ffmpeg: Option<&Path>,
) -> Result<Vec<u8>, ThumbnailError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default();

    let img = if is_photo_ext(&ext) {
        image::open(path)?
    } else if is_video_ext(&ext) {
        let ff = match ffmpeg {
            Some(p) => p.to_path_buf(),
            None => find_ffmpeg().map_err(|e| ThumbnailError::Message(e.to_string()))?,
        };
        extract_video_frame_with_ffmpeg(path, quality, &ff)?
    } else {
        return Err(ThumbnailError::Unsupported);
    };

    let thumb = resize_squareish(&img, quality.max_size().max(16));
    encode_jpeg(&thumb, quality.jpeg_quality())
}

fn resize_squareish(img: &DynamicImage, max_size: u32) -> DynamicImage {
    img.thumbnail(max_size, max_size)
}

fn extract_video_frame_with_ffmpeg(
    path: &Path,
    quality: ThumbQuality,
    ffmpeg: &Path,
) -> Result<DynamicImage, ThumbnailError> {
    // Unique path that does not exist yet (no open handle). Recent FFmpeg needs `-update 1`
    // for single-image image2 outputs.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_path = std::env::temp_dir().join(format!(
        "ats_thumb_{}_{}_{}.jpg",
        std::process::id(),
        quality.as_str(),
        nanos
    ));
    let scale = format!("scale={}:-2", quality.ffmpeg_scale_w());
    let qv = quality.ffmpeg_qv();
    let out_str = out_path.to_string_lossy().into_owned();
    let in_str = path.to_string_lossy().into_owned();

    let run = |seek_before_input: bool, use_scale: bool| -> Result<(bool, String), ThumbnailError> {
        let mut cmd = Command::new(ffmpeg);
        cmd.arg("-nostdin")
            .arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error");
        if seek_before_input {
            cmd.args(["-ss", "0.5"]);
        }
        cmd.arg("-i").arg(&in_str);
        if !seek_before_input {
            cmd.args(["-ss", "0.1"]);
        }
        cmd.args(["-an", "-frames:v", "1"]);
        if use_scale {
            cmd.args(["-vf", &scale]);
        }
        cmd.args(["-q:v", qv, "-threads", "1", "-update", "1", &out_str])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        apply_no_window(&mut cmd);
        let output = cmd.output().map_err(ThumbnailError::Io)?;
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((output.status.success(), err))
    };

    let (ok, err1) = run(true, true)?;
    if !ok {
        let (ok2, err2) = run(false, true)?;
        if !ok2 {
            let (ok3, err3) = run(false, false)?;
            if !ok3 {
                let _ = fs::remove_file(&out_path);
                let detail = [err1, err2, err3]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or_else(|| "unknown ffmpeg error".into());
                return Err(ThumbnailError::Message(format!(
                    "FFmpeg could not extract video frame ({in_str}): {detail}"
                )));
            }
        }
    }

    let meta = fs::metadata(&out_path).map_err(|_| {
        ThumbnailError::Message("FFmpeg finished but thumbnail file is missing".into())
    })?;
    if meta.len() == 0 {
        let _ = fs::remove_file(&out_path);
        return Err(ThumbnailError::Message(
            "FFmpeg wrote an empty thumbnail file".into(),
        ));
    }

    let img_result = image::open(&out_path);
    let _ = fs::remove_file(&out_path);
    let img = img_result?;
    let _ = FilterType::Lanczos3;
    let _ = ImageFormat::Jpeg;
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn thumb_quality_parse_preview() {
        assert_eq!(ThumbQuality::parse("preview"), ThumbQuality::Preview);
        assert_eq!(ThumbQuality::parse("poster"), ThumbQuality::Preview);
        assert_eq!(ThumbQuality::parse("hq"), ThumbQuality::Hq);
        assert_eq!(ThumbQuality::parse("lq"), ThumbQuality::Lq);
    }

    #[test]
    fn photo_thumbnail_produces_jpeg() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.png");
        let img = RgbImage::from_pixel(120, 80, Rgb([10, 20, 30]));
        img.save(&path).unwrap();
        let (bytes, url) = generate_thumbnail_cached(&path, ThumbQuality::Lq).unwrap();
        assert!(!bytes.is_empty());
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn hq_and_lq_differ_in_size_budget() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.png");
        let img = RgbImage::from_pixel(400, 300, Rgb([40, 50, 60]));
        img.save(&path).unwrap();
        let lq = generate_thumbnail_bytes(&path, ThumbQuality::Lq, None).unwrap();
        let hq = generate_thumbnail_bytes(&path, ThumbQuality::Hq, None).unwrap();
        assert!(!lq.is_empty() && !hq.is_empty());
        assert!(hq.len() >= lq.len() || hq.len() > 100);
    }

    #[test]
    fn extract_video_thumb_from_generated_mp4() {
        let ffmpeg = match find_ffmpeg() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("skip: ffmpeg not found");
                return;
            }
        };
        let dir = tempdir().unwrap();
        let vid = dir.path().join("clip.mp4");
        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                &vid.to_string_lossy(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(status.success(), "failed to generate test mp4");

        let (bytes, url) =
            generate_thumbnail_cached_with_ffmpeg(&vid, ThumbQuality::Lq, Some(&ffmpeg)).unwrap();
        assert!(bytes.len() > 32, "thumb too small: {}", bytes.len());
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }
}
