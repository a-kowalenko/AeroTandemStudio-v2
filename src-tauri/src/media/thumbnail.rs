//! Media thumbnails (photos via `image`, videos via FFmpeg frame extract).

use std::io::Cursor;
use std::path::Path;
use std::process::{Command, Stdio};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use thiserror::Error;

use crate::media::dji_paths::{is_photo_ext, is_video_ext};
use crate::video::ffmpeg::find_ffmpeg;

pub const THUMB_MAX_SIZE: u32 = 78; // ~60 * 1.3 like legacy

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

/// Generate a JPEG thumbnail and return `(jpeg_bytes, data_url)`.
pub fn generate_thumbnail_jpeg(path: &Path, max_size: u32) -> Result<(Vec<u8>, String), ThumbnailError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default();

    let img = if is_photo_ext(&ext) {
        image::open(path)?
    } else if is_video_ext(&ext) {
        extract_video_frame(path)?
    } else {
        return Err(ThumbnailError::Unsupported);
    };

    let thumb = resize_squareish(&img, max_size.max(16));
    let mut jpeg = Vec::new();
    {
        let mut cursor = Cursor::new(&mut jpeg);
        thumb
            .write_to(&mut cursor, ImageFormat::Jpeg)
            .map_err(|e| ThumbnailError::Message(e.to_string()))?;
    }
    let data_url = format!("data:image/jpeg;base64,{}", B64.encode(&jpeg));
    Ok((jpeg, data_url))
}

fn resize_squareish(img: &DynamicImage, max_size: u32) -> DynamicImage {
    img.thumbnail(max_size, max_size)
}

fn extract_video_frame(path: &Path) -> Result<DynamicImage, ThumbnailError> {
    let ffmpeg = find_ffmpeg().map_err(|e| ThumbnailError::Message(e.to_string()))?;
    let tmp = tempfile::Builder::new()
        .suffix(".jpg")
        .tempfile()
        .map_err(|e| ThumbnailError::Message(e.to_string()))?;
    let out_path = tmp.path().to_path_buf();

    let status = Command::new(&ffmpeg)
        .args([
            "-nostdin",
            "-y",
            "-ss",
            "0.5",
            "-i",
            &path.to_string_lossy(),
            "-frames:v",
            "1",
            "-q:v",
            "5",
            &out_path.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;

    if !status.success() {
        // Retry from start without seek.
        let status2 = Command::new(&ffmpeg)
            .args([
                "-nostdin",
                "-y",
                "-i",
                &path.to_string_lossy(),
                "-frames:v",
                "1",
                "-q:v",
                "5",
                &out_path.to_string_lossy(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status2.success() {
            return Err(ThumbnailError::Message(
                "FFmpeg could not extract video frame".into(),
            ));
        }
    }

    let img = image::open(&out_path)?;
    // Keep tempfile until after open.
    drop(tmp);
    let _ = FilterType::Lanczos3; // silence unused if thumbnail path changes
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn photo_thumbnail_produces_jpeg() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.png");
        let img = RgbImage::from_pixel(120, 80, Rgb([10, 20, 30]));
        img.save(&path).unwrap();
        let (bytes, url) = generate_thumbnail_jpeg(&path, THUMB_MAX_SIZE).unwrap();
        assert!(!bytes.is_empty());
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }
}
