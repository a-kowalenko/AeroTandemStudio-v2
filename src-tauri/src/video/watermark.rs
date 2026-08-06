//! Watermark / preview media (port of legacy `_create_video_with_watermark`
//! and `_create_photo_with_watermark`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};

use crate::constants::ASSET_PREVIEW_STEMPEL;
use crate::video::concat::VideoCodec;
use crate::video::encoding_quality::build_encode_output_params;
use crate::video::ffmpeg::{probe_duration_secs, run_ffmpeg, FfmpegError, ProgressCallback};
use crate::video::hw_accel::detect_hardware;
use crate::video::processor::{find_asset, ProcessorError};

/// Build FFmpeg args for 320×240 preview video with centered stamp overlay.
pub fn build_watermark_video_args(
    input: &str,
    stamp: &str,
    output: &str,
    force_software: bool,
) -> (String, Vec<String>) {
    let hw = detect_hardware();
    let (encoder, mut enc_params) =
        build_encode_output_params(&hw, VideoCodec::H264, 28, force_software || !hw.available);

    // Prefer faster software settings when falling back
    if encoder == "libx264" {
        enc_params = vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "28".into(),
        ];
    }

    let filter = concat!(
        "[0]scale=320:240:force_original_aspect_ratio=decrease,",
        "pad=320:240:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p[v];",
        "[1]scale=320:240:force_original_aspect_ratio=decrease:eval=init[wm_scaled];",
        "[v][wm_scaled]overlay=(W-w)/2:(H-h)/2"
    );

    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.to_string(),
        "-i".into(),
        stamp.to_string(),
        "-filter_complex".into(),
        filter.to_string(),
    ];
    args.extend(enc_params);
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        "-an".into(),
        output.to_string(),
    ]);
    (encoder, args)
}

pub fn create_video_with_watermark(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
) -> Result<String, ProcessorError> {
    let stamp = find_asset(ASSET_PREVIEW_STEMPEL, resource_dir)?;
    let duration = probe_duration_secs(ffmpeg, input).unwrap_or(1.0);
    let (encoder, args) =
        build_watermark_video_args(input, stamp.to_string_lossy().as_ref(), output, false);

    if let Err(e) = run_ffmpeg(ffmpeg, &args, duration, Arc::clone(&on_progress)) {
        // Retry software if HW failed
        if !matches!(e, FfmpegError::Cancelled) {
            let (_, args_sw) =
                build_watermark_video_args(input, stamp.to_string_lossy().as_ref(), output, true);
            run_ffmpeg(ffmpeg, &args_sw, duration, on_progress)?;
            return Ok("libx264".into());
        }
        return Err(e.into());
    }
    Ok(encoder)
}

/// Scale photo to height 720 and overlay `preview_stempel.png` centered (image crate).
pub fn create_photo_with_watermark(
    input: &Path,
    output: &Path,
    stamp_path: &Path,
) -> Result<(), ProcessorError> {
    let foto = image::open(input).map_err(|e| {
        ProcessorError::Message(format!("Foto öffnen {}: {e}", input.display()))
    })?;
    let stamp = image::open(stamp_path).map_err(|e| {
        ProcessorError::Message(format!("Stempel öffnen {}: {e}", stamp_path.display()))
    })?;

    let target_h = 720u32;
    let aspect = foto.width() as f64 / foto.height().max(1) as f64;
    let new_w = ((target_h as f64) * aspect).round().max(1.0) as u32;
    let mut foto_rgba = foto
        .resize_exact(new_w, target_h, FilterType::Lanczos3)
        .to_rgba8();

    let wm = stamp.to_rgba8();
    let wm_aspect = wm.width() as f64 / wm.height().max(1) as f64;
    let foto_aspect = foto_rgba.width() as f64 / foto_rgba.height().max(1) as f64;

    let (wm_w, wm_h) = if wm_aspect > foto_aspect {
        let w = foto_rgba.width();
        let h = ((w as f64) / wm_aspect).round().max(1.0) as u32;
        (w, h)
    } else {
        let h = foto_rgba.height();
        let w = ((h as f64) * wm_aspect).round().max(1.0) as u32;
        (w, h)
    };

    let wm_scaled = DynamicImage::ImageRgba8(wm)
        .resize_exact(wm_w, wm_h, FilterType::Lanczos3)
        .to_rgba8();

    let paste_x = (foto_rgba.width().saturating_sub(wm_w)) / 2;
    let paste_y = (foto_rgba.height().saturating_sub(wm_h)) / 2;
    overlay_rgba(&mut foto_rgba, &wm_scaled, paste_x, paste_y);

    let rgb = DynamicImage::ImageRgba8(foto_rgba).to_rgb8();
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rgb.save_with_format(output, ImageFormat::Jpeg)
        .map_err(|e| ProcessorError::Message(format!("Foto speichern: {e}")))?;
    Ok(())
}

fn overlay_rgba(base: &mut RgbaImage, overlay: &RgbaImage, ox: u32, oy: u32) {
    for (x, y, pixel) in overlay.enumerate_pixels() {
        let dx = ox + x;
        let dy = oy + y;
        if dx >= base.width() || dy >= base.height() {
            continue;
        }
        let src = pixel.0;
        let alpha = src[3] as f32 / 255.0;
        if alpha <= 0.0 {
            continue;
        }
        let dst = base.get_pixel_mut(dx, dy);
        for c in 0..3 {
            dst.0[c] = ((src[c] as f32) * alpha + (dst.0[c] as f32) * (1.0 - alpha)).round() as u8;
        }
        dst.0[3] = 255;
    }
}

pub fn resolve_stamp(resource_dir: Option<&Path>) -> Result<PathBuf, ProcessorError> {
    find_asset(ASSET_PREVIEW_STEMPEL, resource_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watermark_video_args_contain_overlay() {
        let (enc, args) = build_watermark_video_args("in.mp4", "stamp.png", "out.mp4", true);
        assert_eq!(enc, "libx264");
        assert!(args.iter().any(|a| a.contains("overlay")));
        assert!(args.contains(&"-an".to_string()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }
}
