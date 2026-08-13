//! Pixel-rotate photos (working copies) with EXIF orientation baked in.
//!
//! After apply, pixels are upright and Orientation is treated as 1 (no tag /
//! stripped on re-encode via `image`). Export/WM paths use `image::open` and
//! ignore EXIF orientation, so baking is required.

use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use exif::{In, Reader as ExifReader, Tag};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use thiserror::Error;

use super::photo_edit_undo;

#[derive(Debug, Error)]
pub enum PhotoRotateError {
    #[error("{0}")]
    Message(String),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct PhotoRotateResult {
    pub output: String,
    pub degrees: u32,
    pub overwritten: bool,
    pub width: u32,
    pub height: u32,
}

/// Normalize to `{0, 90, 180, 270}`.
pub fn normalize_rotation_degrees(degrees: i32) -> Result<u32, PhotoRotateError> {
    let d = degrees.rem_euclid(360);
    if d % 90 != 0 {
        return Err(PhotoRotateError::Message(
            "Drehung muss ein Vielfaches von 90° sein".into(),
        ));
    }
    Ok(d as u32)
}

pub(crate) fn read_exif_orientation(path: &Path) -> u32 {
    let Ok(file) = fs::File::open(path) else {
        return 1;
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = ExifReader::new().read_from_container(&mut reader) else {
        return 1;
    };
    exif.get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|f| match f.value.get_uint(0) {
            Some(v) if (1..=8).contains(&v) => Some(v),
            _ => None,
        })
        .unwrap_or(1)
}

/// Apply EXIF Orientation tag to pixels (tag values 1–8).
pub fn apply_exif_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

pub fn rotate_dynamic(img: DynamicImage, degrees: u32) -> Result<DynamicImage, PhotoRotateError> {
    match degrees {
        0 => Ok(img),
        90 => Ok(img.rotate90()),
        180 => Ok(img.rotate180()),
        270 => Ok(img.rotate270()),
        _ => Err(PhotoRotateError::Message(
            "Drehung muss 90, 180 oder 270 Grad sein".into(),
        )),
    }
}

pub(crate) fn detect_format(path: &Path) -> ImageFormat {
    ImageFormat::from_path(path).unwrap_or_else(|_| {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("png") => ImageFormat::Png,
            Some("webp") => ImageFormat::WebP,
            Some("tif") | Some("tiff") => ImageFormat::Tiff,
            Some("bmp") => ImageFormat::Bmp,
            _ => ImageFormat::Jpeg,
        }
    })
}

fn temp_rotate_path(photo_path: &str) -> PathBuf {
    let path = Path::new(photo_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("photo");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg");
    path.with_file_name(format!("{stem}.__temp_rotate__.{ext}"))
}

pub(crate) fn save_image(
    img: &DynamicImage,
    path: &Path,
    format: ImageFormat,
) -> Result<(), PhotoRotateError> {
    match format {
        ImageFormat::Jpeg => {
            let rgb = img.to_rgb8();
            let mut file = fs::File::create(path)?;
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 92);
            encoder.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )?;
        }
        other => {
            img.save_with_format(path, other)?;
        }
    }
    Ok(())
}

/// Rotate photo working copy: bake EXIF orientation, then apply `degrees` CW.
pub fn rotate_photo(
    input: &str,
    degrees: i32,
    output: Option<&str>,
    overwrite: bool,
) -> Result<PhotoRotateResult, PhotoRotateError> {
    if !Path::new(input).is_file() {
        return Err(PhotoRotateError::Message(format!(
            "input file not found: {input}"
        )));
    }
    let deg = normalize_rotation_degrees(degrees)?;
    if deg == 0 {
        return Err(PhotoRotateError::Message("Keine Drehung nötig (0°)".into()));
    }

    let (target, is_overwrite) = if overwrite {
        (temp_rotate_path(input), true)
    } else {
        let out = output
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                PhotoRotateError::Message("output path is required when overwrite=false".into())
            })?;
        (PathBuf::from(out), false)
    };

    let backup = if is_overwrite {
        Some(
            photo_edit_undo::prepare_overwrite_backup(input)
                .map_err(|e| PhotoRotateError::Message(e.to_string()))?,
        )
    } else {
        None
    };

    let result = (|| -> Result<PhotoRotateResult, PhotoRotateError> {
        let path = Path::new(input);
        let orientation = read_exif_orientation(path);
        let mut img = image::open(path)?;
        img = apply_exif_orientation(img, orientation);
        img = rotate_dynamic(img, deg)?;
        let format = detect_format(path);
        save_image(&img, &target, format)?;

        let width = img.width();
        let height = img.height();

        let final_output = if is_overwrite {
            if !target.is_file() {
                return Err(PhotoRotateError::Message(
                    "temp rotate output missing".into(),
                ));
            }
            fs::rename(&target, input)?;
            input.to_string()
        } else {
            target.to_string_lossy().to_string()
        };

        Ok(PhotoRotateResult {
            output: final_output,
            degrees: deg,
            overwritten: is_overwrite,
            width,
            height,
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
    use image::{Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn normalize_degrees() {
        assert_eq!(normalize_rotation_degrees(-90).unwrap(), 270);
        assert!(normalize_rotation_degrees(45).is_err());
    }

    #[test]
    fn apply_exif_6_is_rotate90() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 4, Rgb([1, 2, 3])));
        let out = apply_exif_orientation(img, 6);
        assert_eq!(out.width(), 4);
        assert_eq!(out.height(), 2);
    }

    #[test]
    fn rotate_photo_overwrite_swaps_dims() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jpg");
        let img = RgbImage::from_pixel(4, 2, Rgb([10, 20, 30]));
        DynamicImage::ImageRgb8(img)
            .save_with_format(&path, ImageFormat::Jpeg)
            .unwrap();
        let path_str = path.to_string_lossy().to_string();
        photo_edit_undo::clear_photo_edit_undo();
        let res = rotate_photo(&path_str, 90, None, true).unwrap();
        assert_eq!(res.width, 2);
        assert_eq!(res.height, 4);
        assert!(res.overwritten);
        photo_edit_undo::clear_photo_edit_undo();
    }
}
