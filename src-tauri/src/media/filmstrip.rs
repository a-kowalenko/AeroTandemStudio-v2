//! Video filmstrip frames for Apple-style trim UI (FFmpeg tile → JPEG data URLs).
//! Disk-cached under `{app_config}/filmstrips/` keyed by path+mtime+size+count+height.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::GenericImageView;
use thiserror::Error;

use crate::storage::app_config_dir;
use crate::util::process::apply_no_window;
use crate::video::ffmpeg::{find_ffmpeg, probe_duration_secs};

pub const DEFAULT_FRAME_COUNT: usize = 14;
pub const DEFAULT_FRAME_HEIGHT: u32 = 56;
const MIN_FRAMES: usize = 4;
const MAX_FRAMES: usize = 24;
const JPEG_Q: u8 = 72;

#[derive(Debug, Error)]
pub enum FilmstripError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Message(String),
}

fn filmstrips_dir() -> Result<PathBuf, FilmstripError> {
    let dir = app_config_dir()
        .map_err(|e| FilmstripError::Message(e.to_string()))?
        .join("filmstrips");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn file_identity(path: &Path) -> Result<(u64, u64), FilmstripError> {
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

fn cache_key(path: &Path, mtime: u64, size: u64, count: usize, height: u32) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!(
        "{:016x}_{mtime}_{size}_{count}x{height}",
        hasher.finish()
    )
}

fn to_data_url(jpeg: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", B64.encode(jpeg))
}

fn clamp_count(count: usize) -> usize {
    count.clamp(MIN_FRAMES, MAX_FRAMES)
}

/// Generate (or load from disk cache) `count` evenly spaced filmstrip JPEG data URLs.
pub fn generate_filmstrip(
    path: &Path,
    count: usize,
    height: u32,
    ffmpeg: Option<&Path>,
) -> Result<Vec<String>, FilmstripError> {
    let count = clamp_count(count);
    let height = height.clamp(32, 96);
    let (mtime, size) = file_identity(path)?;
    let key = cache_key(path, mtime, size, count, height);
    let dir = filmstrips_dir()?;

    let mut urls = Vec::with_capacity(count);
    let mut all_cached = true;
    for i in 0..count {
        let cache_path = dir.join(format!("{key}_{i:02}.jpg"));
        if cache_path.is_file() {
            if let Ok(bytes) = fs::read(&cache_path) {
                if bytes.len() > 32 {
                    urls.push(to_data_url(&bytes));
                    continue;
                }
                let _ = fs::remove_file(&cache_path);
            }
        }
        all_cached = false;
        break;
    }
    if all_cached && urls.len() == count {
        return Ok(urls);
    }

    let ff = match ffmpeg {
        Some(p) => p.to_path_buf(),
        None => find_ffmpeg().map_err(|e| FilmstripError::Message(e.to_string()))?,
    };

    let frames = extract_filmstrip_jpegs(path, &ff, count, height)?;
    for (i, jpeg) in frames.iter().enumerate() {
        let cache_path = dir.join(format!("{key}_{i:02}.jpg"));
        let _ = fs::write(&cache_path, jpeg);
    }
    Ok(frames.into_iter().map(|b| to_data_url(&b)).collect())
}

fn extract_filmstrip_jpegs(
    path: &Path,
    ffmpeg: &Path,
    count: usize,
    height: u32,
) -> Result<Vec<Vec<u8>>, FilmstripError> {
    let in_str = path.to_string_lossy().into_owned();
    let duration = probe_duration_secs(ffmpeg, &in_str)
        .map_err(|e| FilmstripError::Message(e.to_string()))?
        .max(0.05);

    // Sample `count` frames across the clip (avoid exact EOF).
    let fps = (count as f64) / duration.max(0.05);
    let fps = fps.clamp(0.05, 30.0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_path = std::env::temp_dir().join(format!(
        "ats_filmstrip_{}_{}.jpg",
        std::process::id(),
        nanos
    ));
    let out_str = out_path.to_string_lossy().into_owned();

    // Even height for libx264-friendly scales; tile into one horizontal strip.
    let vf = format!(
        "fps={fps:.6},scale=-2:{height},tile={count}x1"
    );

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &in_str,
        "-an",
        "-vf",
        &vf,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        "-update",
        "1",
        &out_str,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let output = cmd.output().map_err(FilmstripError::Io)?;
    if !output.status.success() || !out_path.is_file() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&out_path);
        return Err(FilmstripError::Message(format!(
            "FFmpeg filmstrip failed ({in_str}): {}",
            if err.is_empty() {
                "unknown error"
            } else {
                &err
            }
        )));
    }

    let img = image::open(&out_path)?;
    let _ = fs::remove_file(&out_path);

    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err(FilmstripError::Message("empty filmstrip image".into()));
    }

    // FFmpeg may produce fewer tiles than requested on very short clips.
    let tile_w = (w as f64 / count as f64).round().max(1.0) as u32;
    let actual = ((w as f64) / (tile_w as f64)).round().max(1.0) as usize;
    let actual = actual.min(count).max(1);
    let tile_w = w / actual as u32;
    if tile_w == 0 {
        return Err(FilmstripError::Message("invalid filmstrip tile width".into()));
    }

    let mut frames = Vec::with_capacity(count);
    for i in 0..actual {
        let x = i as u32 * tile_w;
        let crop_w = if i + 1 == actual { w - x } else { tile_w };
        let frame = img.crop_imm(x, 0, crop_w, h);
        let mut jpeg = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut jpeg);
            let encoder = JpegEncoder::new_with_quality(&mut cursor, JPEG_Q);
            frame
                .write_with_encoder(encoder)
                .map_err(|e| FilmstripError::Message(e.to_string()))?;
        }
        if jpeg.len() <= 32 {
            continue;
        }
        frames.push(jpeg);
    }

    if frames.is_empty() {
        return Err(FilmstripError::Message("no filmstrip frames produced".into()));
    }

    // Pad by repeating last frame if FFmpeg returned fewer tiles.
    while frames.len() < count {
        frames.push(frames.last().unwrap().clone());
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::ffmpeg::find_ffmpeg;
    use tempfile::tempdir;

    #[test]
    fn clamp_count_bounds() {
        assert_eq!(clamp_count(1), MIN_FRAMES);
        assert_eq!(clamp_count(100), MAX_FRAMES);
        assert_eq!(clamp_count(14), 14);
    }

    #[test]
    fn filmstrip_from_generated_mp4() {
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
                "color=c=blue:s=320x240:d=2",
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

        let urls =
            generate_filmstrip(&vid, 8, 48, Some(&ffmpeg)).expect("filmstrip");
        assert_eq!(urls.len(), 8);
        assert!(urls[0].starts_with("data:image/jpeg;base64,"));
        assert!(urls[0].len() > 64);
    }
}
