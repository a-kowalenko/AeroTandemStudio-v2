//! Pixel-crop photos (working copies) with EXIF orientation baked in first.

use std::fs;
use std::path::{Path, PathBuf};

use image::DynamicImage;
use serde::Serialize;
use thiserror::Error;

use super::photo_edit_undo;
use super::rotate::{
    apply_exif_orientation, detect_format, read_exif_orientation, save_image,
};

/// Minimum crop edge as fraction of the shorter image side.
const MIN_NORM_EDGE: f64 = 0.05;
/// Absolute minimum crop edge in pixels.
const MIN_PIXEL_EDGE: u32 = 32;

#[derive(Debug, Error)]
pub enum PhotoCropError {
    #[error("{0}")]
    Message(String),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Rotate(#[from] super::rotate::PhotoRotateError),
}

#[derive(Debug, Clone, Serialize)]
pub struct PhotoCropResult {
    pub output: String,
    pub overwritten: bool,
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
}

/// Normalized crop rectangle (origin top-left, relative to EXIF-baked image).
#[derive(Debug, Clone, Copy)]
pub struct NormCropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Map normalized rect → inclusive pixel region `(x, y, w, h)`.
pub fn norm_crop_to_pixels(
    rect: NormCropRect,
    img_w: u32,
    img_h: u32,
) -> Result<(u32, u32, u32, u32), PhotoCropError> {
    if img_w == 0 || img_h == 0 {
        return Err(PhotoCropError::Message("invalid image size".into()));
    }
    if !(rect.w.is_finite() && rect.h.is_finite() && rect.x.is_finite() && rect.y.is_finite()) {
        return Err(PhotoCropError::Message("crop rect must be finite".into()));
    }
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return Err(PhotoCropError::Message("crop size must be positive".into()));
    }

    let min_side = f64::from(img_w.min(img_h));
    let min_norm = (f64::from(MIN_PIXEL_EDGE) / min_side).max(MIN_NORM_EDGE).min(1.0);
    if rect.w + 1e-9 < min_norm || rect.h + 1e-9 < min_norm {
        return Err(PhotoCropError::Message(format!(
            "crop too small (min {:.0}% / {MIN_PIXEL_EDGE}px)",
            min_norm * 100.0
        )));
    }

    let x0 = (rect.x.clamp(0.0, 1.0) * f64::from(img_w)).floor() as i64;
    let y0 = (rect.y.clamp(0.0, 1.0) * f64::from(img_h)).floor() as i64;
    let x1 = ((rect.x + rect.w).clamp(0.0, 1.0) * f64::from(img_w)).ceil() as i64;
    let y1 = ((rect.y + rect.h).clamp(0.0, 1.0) * f64::from(img_h)).ceil() as i64;

    let x0 = x0.clamp(0, i64::from(img_w)) as u32;
    let y0 = y0.clamp(0, i64::from(img_h)) as u32;
    let x1 = x1.clamp(0, i64::from(img_w)) as u32;
    let y1 = y1.clamp(0, i64::from(img_h)) as u32;

    if x1 <= x0 || y1 <= y0 {
        return Err(PhotoCropError::Message("crop outside image".into()));
    }
    let w = x1 - x0;
    let h = y1 - y0;
    if w < MIN_PIXEL_EDGE || h < MIN_PIXEL_EDGE {
        return Err(PhotoCropError::Message(format!(
            "crop too small (min {MIN_PIXEL_EDGE}px)"
        )));
    }
    if w >= img_w && h >= img_h {
        return Err(PhotoCropError::Message("Kein Zuschnitt nötig (Vollbild)".into()));
    }
    Ok((x0, y0, w, h))
}

fn temp_crop_path(photo_path: &str) -> PathBuf {
    let path = Path::new(photo_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("photo");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg");
    path.with_file_name(format!("{stem}.__temp_crop__.{ext}"))
}

fn crop_dynamic(img: DynamicImage, x: u32, y: u32, w: u32, h: u32) -> DynamicImage {
    img.crop_imm(x, y, w, h)
}

/// Crop photo working copy: bake EXIF orientation, then crop with normalized rect.
pub fn crop_photo(
    input: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    output: Option<&str>,
    overwrite: bool,
) -> Result<PhotoCropResult, PhotoCropError> {
    if !Path::new(input).is_file() {
        return Err(PhotoCropError::Message(format!(
            "input file not found: {input}"
        )));
    }

    let (target, is_overwrite) = if overwrite {
        (temp_crop_path(input), true)
    } else {
        let out = output
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                PhotoCropError::Message("output path is required when overwrite=false".into())
            })?;
        (PathBuf::from(out), false)
    };

    let backup = if is_overwrite {
        Some(
            photo_edit_undo::prepare_overwrite_backup(input)
                .map_err(|e| PhotoCropError::Message(e.to_string()))?,
        )
    } else {
        None
    };

    let result = (|| -> Result<PhotoCropResult, PhotoCropError> {
        let path = Path::new(input);
        let orientation = read_exif_orientation(path);
        let mut img = image::open(path)?;
        img = apply_exif_orientation(img, orientation);

        let (px, py, pw, ph) = norm_crop_to_pixels(
            NormCropRect { x, y, w, h },
            img.width(),
            img.height(),
        )?;
        img = crop_dynamic(img, px, py, pw, ph);

        let format = detect_format(path);
        save_image(&img, &target, format)?;

        let width = img.width();
        let height = img.height();

        let final_output = if is_overwrite {
            if !target.is_file() {
                return Err(PhotoCropError::Message("temp crop output missing".into()));
            }
            fs::rename(&target, input)?;
            input.to_string()
        } else {
            target.to_string_lossy().to_string()
        };

        Ok(PhotoCropResult {
            output: final_output,
            overwritten: is_overwrite,
            width,
            height,
            x: px,
            y: py,
        })
    })();

    match result {
        Ok(res) => {
            if let Some(b) = backup {
                photo_edit_undo::commit_edit_undo(input, b);
            }
            Ok(res)
        }
        Err(e) => {
            if let Some(Some(b)) = backup {
                photo_edit_undo::discard_backup(&b);
            }
            let _ = fs::remove_file(&target);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn norm_to_pixels_basic() {
        let (x, y, w, h) =
            norm_crop_to_pixels(NormCropRect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 200, 100)
                .unwrap();
        assert_eq!((x, y, w, h), (50, 25, 100, 50));
    }

    #[test]
    fn norm_rejects_full_frame() {
        let err = norm_crop_to_pixels(
            NormCropRect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            200,
            100,
        );
        assert!(err.is_err());
    }

    #[test]
    fn norm_rejects_tiny() {
        let err = norm_crop_to_pixels(
            NormCropRect {
                x: 0.0,
                y: 0.0,
                w: 0.01,
                h: 0.01,
            },
            1000,
            1000,
        );
        assert!(err.is_err());
    }

    #[test]
    fn crop_photo_overwrite_shrinks() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jpg");
        let img = RgbImage::from_pixel(200, 100, Rgb([10, 20, 30]));
        DynamicImage::ImageRgb8(img)
            .save_with_format(&path, ImageFormat::Jpeg)
            .unwrap();
        let path_str = path.to_string_lossy().to_string();
        photo_edit_undo::clear_photo_edit_undo();
        let res = crop_photo(&path_str, 0.25, 0.25, 0.5, 0.5, None, true).unwrap();
        assert_eq!(res.width, 100);
        assert_eq!(res.height, 50);
        assert!(res.overwritten);
        photo_edit_undo::clear_photo_edit_undo();
    }
}
