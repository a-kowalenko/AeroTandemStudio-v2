//! QR analyser — FFmpeg frame extraction + rxing decode + JSON → `Kunde`.
//!
//! Behaviour port of legacy `qr_analyser.py` (without OpenCV / pyzbar).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use image::imageops::FilterType;
use image::GenericImageView;
use rxing::common::HybridBinarizer;
use rxing::{
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource, MultiFormatReader, Reader,
};
use serde::Serialize;
use thiserror::Error;

use crate::model::Kunde;
use crate::video::ffmpeg::{self, run_ffmpeg_checked, FfmpegError};
use crate::video::probe;

pub const DEFAULT_QR_VIDEO_SCAN_SECONDS: f64 = 5.0;
pub const DEFAULT_QR_FRAME_STEP: u32 = 10;
pub const MAX_QR_DECODE_WIDTH: u32 = 1920;
pub const MAX_QR_VIDEO_DECODE_WIDTH: u32 = 1280;
/// Temp dirs for hit-frame previews shown in SuccessDialog.
pub const QR_PREVIEW_DIR_PREFIX: &str = "aero_studio_qr_preview_";
/// Extra padding around the QR AABB before forming a square (fraction of side).
const SPOTLIGHT_PAD: f32 = 0.2;
/// Minimum spotlight size as a fraction of the shorter image side.
const SPOTLIGHT_MIN_FRAC: f32 = 0.08;

#[derive(Debug, Error)]
pub enum QrScanError {
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("QR parse error: {0}")]
    Parse(String),
    #[error("FFmpeg error: {0}")]
    Ffmpeg(#[from] FfmpegError),
    #[error("image error: {0}")]
    Image(String),
    #[error("{0}")]
    Message(String),
}

/// Normalized square over the preview image (0–1), for CSS spotlight overlay.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QrSpotlight {
    pub x: f32,
    pub y: f32,
    pub size: f32,
}

/// Persisted hit-frame (or decode image) for the success dialog.
#[derive(Debug, Clone, Serialize)]
pub struct QrPreview {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub spotlight: Option<QrSpotlight>,
}

/// Direction for post-hit QR photo cleanup within a capture series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CleanupDirection {
    #[default]
    Forward,
    Backward,
}

#[derive(Debug, Clone, Serialize)]
pub struct QrScanResult {
    pub found: bool,
    pub kunde: Option<Kunde>,
    pub source_path: Option<String>,
    pub cancelled: bool,
    pub message: String,
    pub preview: Option<QrPreview>,
    /// Which way to walk the photo series after a hit (from parallel worker direction).
    pub cleanup_direction: CleanupDirection,
}

impl QrScanResult {
    pub fn hit(kunde: Kunde, source_path: impl Into<String>, preview: Option<QrPreview>) -> Self {
        let source_path = source_path.into();
        Self {
            found: true,
            kunde: Some(kunde),
            source_path: Some(source_path.clone()),
            cancelled: false,
            message: format!("QR-Code gefunden: {source_path}"),
            preview,
            cleanup_direction: CleanupDirection::Forward,
        }
    }

    pub fn with_cleanup_direction(mut self, direction: CleanupDirection) -> Self {
        self.cleanup_direction = direction;
        self
    }

    pub fn miss(message: impl Into<String>) -> Self {
        Self {
            found: false,
            kunde: None,
            source_path: None,
            cancelled: false,
            message: message.into(),
            preview: None,
            cleanup_direction: CleanupDirection::Forward,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            found: false,
            kunde: None,
            source_path: None,
            cancelled: true,
            message: "QR-Scan abgebrochen.".into(),
            preview: None,
            cleanup_direction: CleanupDirection::Forward,
        }
    }
}

/// Build an axis-aligned square covering the QR finder/corner points.
/// Coordinates are normalized 0–1; `size` is a fraction of **image width**
/// (so CSS `width`% + equal aspect yields a square on the image box).
pub fn spotlight_from_points(
    points: &[(f32, f32)],
    image_width: u32,
    image_height: u32,
) -> Option<QrSpotlight> {
    if points.is_empty() || image_width == 0 || image_height == 0 {
        return None;
    }
    let w = image_width as f32;
    let h = image_height as f32;
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    for &(x, y) in points {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    let aabb_w = (max_x - min_x).max(1.0);
    let aabb_h = (max_y - min_y).max(1.0);
    let mut side = aabb_w.max(aabb_h) * (1.0 + SPOTLIGHT_PAD);
    let min_side = w.min(h) * SPOTLIGHT_MIN_FRAC;
    side = side.max(min_side).min(w).min(h);

    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let mut left = cx - side * 0.5;
    let mut top = cy - side * 0.5;
    left = left.clamp(0.0, (w - side).max(0.0));
    top = top.clamp(0.0, (h - side).max(0.0));

    Some(QrSpotlight {
        x: (left / w).clamp(0.0, 1.0),
        y: (top / h).clamp(0.0, 1.0),
        size: (side / w).clamp(0.0, 1.0),
    })
}

fn persist_qr_preview_image(img: &image::DynamicImage) -> Result<PathBuf, QrScanError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "{QR_PREVIEW_DIR_PREFIX}{}_{millis}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).map_err(|e| QrScanError::Message(e.to_string()))?;
    let path = dir.join("hit.png");
    img.save(&path)
        .map_err(|e| QrScanError::Image(format!("preview save failed: {e}")))?;
    Ok(path)
}

/// Delete a QR preview file and its parent `aero_studio_qr_preview_*` directory when safe.
pub fn discard_qr_preview(path: &str) -> Result<(), String> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if path.is_file() {
        let _ = fs::remove_file(path);
    }
    if let Some(parent) = path.parent() {
        let name = parent
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name.starts_with(QR_PREVIEW_DIR_PREFIX) {
            let _ = fs::remove_dir_all(parent);
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct QrScanOptions {
    pub scan_seconds: f64,
    pub frame_step: u32,
    pub max_video_width: u32,
    pub max_photo_width: u32,
}

impl Default for QrScanOptions {
    fn default() -> Self {
        Self {
            scan_seconds: DEFAULT_QR_VIDEO_SCAN_SECONDS,
            frame_step: DEFAULT_QR_FRAME_STEP,
            max_video_width: MAX_QR_VIDEO_DECODE_WIDTH,
            max_photo_width: MAX_QR_DECODE_WIDTH,
        }
    }
}

/// Build FFmpeg args to extract a single frame as PNG (seek-before-input).
pub fn build_extract_frame_args(
    input: &str,
    seek_secs: f64,
    output_png: &str,
    max_width: u32,
) -> Vec<String> {
    let seek = format!("{:.3}", seek_secs.max(0.0));
    let vf = format!("scale='min({max_width},iw)':-1");
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        seek,
        "-i".into(),
        input.to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf,
        "-y".into(),
        output_png.to_string(),
    ]
}

/// Frame indices for QR search (frame 0 always included). Port of legacy `_target_frame_indices`.
pub fn target_frame_indices(fps: f64, scan_seconds: f64, frame_step: u32) -> Vec<u32> {
    let fps = if fps > 0.0 { fps } else { 30.0 };
    let scan_seconds = scan_seconds.max(0.5);
    let frames_limit = ((fps * scan_seconds) as u32).max(1);
    let step = frame_step.max(1);
    let mut indices = Vec::new();
    let mut i = 0u32;
    while i < frames_limit {
        indices.push(i);
        i = i.saturating_add(step);
        if step == 0 {
            break;
        }
    }
    indices
}

/// Parse QR payload into `Kunde` (URL fragment after `#` or raw JSON).
pub fn parse_kunde_from_qr_string(qr_daten_str: &str) -> Result<Kunde, QrScanError> {
    let mut payload = qr_daten_str.trim();
    if let Some((_, after)) = payload.split_once('#') {
        payload = after;
    }

    let daten: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| QrScanError::Parse(format!("invalid JSON: {e}")))?;

    let media_code = match daten.get("media") {
        None | Some(serde_json::Value::Null) => "none".to_string(),
        Some(v) => {
            let s = v.as_str().map(str::trim).unwrap_or("").to_string();
            if s.is_empty() {
                "none".into()
            } else {
                s
            }
        }
    };

    let (handcam_foto, handcam_video, outside_foto, outside_video) =
        media_flags_from_code(&media_code)
            .ok_or_else(|| QrScanError::Parse(format!("unknown media code: {media_code}")))?;

    let kunde_id = daten
        .get("Customer_ID")
        .or_else(|| daten.get("customer_id"))
        .or_else(|| daten.get("hashid"))
        .and_then(|v| value_as_string(v))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| QrScanError::Parse("missing Customer_ID".into()))?;

    let booking_id = daten
        .get("Booking_ID")
        .or_else(|| daten.get("booking_id"))
        .and_then(value_as_string);

    let vorname = daten
        .get("vorname")
        .and_then(value_as_string)
        .ok_or_else(|| QrScanError::Parse("missing vorname".into()))?;
    let nachname = daten
        .get("nachname")
        .and_then(value_as_string)
        .ok_or_else(|| QrScanError::Parse("missing nachname".into()))?;

    let gast = format!("{vorname} {nachname}").trim().to_string();
    let video_mode = if handcam_foto || handcam_video {
        "handcam".to_string()
    } else if outside_foto || outside_video {
        "outside".to_string()
    } else {
        String::new()
    };

    Ok(Kunde {
        kunden_id: None,
        kunden_id_hash: Some(kunde_id),
        booking_id: None,
        booking_id_hash: booking_id,
        email: None,
        vorname: Some(vorname),
        nachname: Some(nachname),
        telefon: None,
        gast,
        tandemmaster: String::new(),
        videospringer: String::new(),
        datum: String::new(),
        ort: String::new(),
        video_mode,
        form_mode: "kunde".into(),
        handcam_foto,
        handcam_video,
        outside_foto,
        outside_video,
        ist_bezahlt_handcam_foto: handcam_foto,
        ist_bezahlt_handcam_video: handcam_video,
        ist_bezahlt_outside_foto: outside_foto,
        ist_bezahlt_outside_video: outside_video,
    })
}

fn media_flags_from_code(code: &str) -> Option<(bool, bool, bool, bool)> {
    match code {
        "none" => Some((false, false, false, false)),
        "hc_f" => Some((true, false, false, false)),
        "hc_v" => Some((false, true, false, false)),
        "hc_fv" => Some((true, true, false, false)),
        "ou_f" => Some((false, false, true, false)),
        "ou_v" => Some((false, false, false, true)),
        "ou_fv" => Some((false, false, true, true)),
        _ => None,
    }
}

fn value_as_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn is_stop(cancel: Option<&AtomicBool>) -> bool {
    ffmpeg::is_cancelled() || cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false)
}

/// Decode QR text + corner points from a greyscale luma8 buffer.
pub fn decode_qr_from_luma(
    luma: Vec<u8>,
    width: u32,
    height: u32,
) -> Option<(String, Vec<(f32, f32)>)> {
    if width == 0 || height == 0 || luma.len() < (width as usize) * (height as usize) {
        return None;
    }

    let source = Luma8LuminanceSource::new(luma, width, height).ok()?;
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
    let mut hints = DecodeHints::default();
    hints.PossibleFormats = Some(HashSet::from([BarcodeFormat::QR_CODE]));
    hints.TryHarder = Some(true);

    let mut reader = MultiFormatReader::default();
    match reader.decode_with_hints(&mut bitmap, &hints) {
        Ok(result) => {
            let text = result.getText().to_string();
            if text.is_empty() {
                None
            } else {
                let points = result
                    .getPoints()
                    .iter()
                    .map(|p| (p.x, p.y))
                    .collect::<Vec<_>>();
                Some((text, points))
            }
        }
        Err(_) => None,
    }
}

/// Load image path, optionally downscale, convert to luma, decode QR → Kunde + preview.
pub fn decode_kunde_from_image_path(
    path: &Path,
    max_width: u32,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    let img = image::open(path).map_err(|e| QrScanError::Image(e.to_string()))?;
    decode_kunde_from_dynamic_image(img, max_width, true)
}

/// Detect a valid customer QR without persisting a preview image (follow-up cleanup).
pub fn photo_has_customer_qr(path: &Path, max_width: u32) -> Result<bool, QrScanError> {
    let img = image::open(path).map_err(|e| QrScanError::Image(e.to_string()))?;
    Ok(decode_kunde_from_dynamic_image(img, max_width, false)?.is_some())
}

fn decode_kunde_from_dynamic_image(
    img: image::DynamicImage,
    max_width: u32,
    persist_preview: bool,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    let (w, _h) = img.dimensions();
    let img = if w > max_width {
        img.resize(max_width, u32::MAX, FilterType::Triangle)
    } else {
        img
    };

    let gray = img.to_luma8();
    let width = gray.width();
    let height = gray.height();
    let luma = gray.into_raw();

    let Some((text, points)) = decode_qr_from_luma(luma, width, height) else {
        return Ok(None);
    };

    match parse_kunde_from_qr_string(&text) {
        Ok(kunde) => {
            if !persist_preview {
                // Follow-up / detect-only: no spotlight file on disk.
                return Ok(Some((
                    kunde,
                    QrPreview {
                        path: String::new(),
                        width,
                        height,
                        spotlight: None,
                    },
                )));
            }
            let preview_path = persist_qr_preview_image(&img)?;
            let spotlight = spotlight_from_points(&points, width, height);
            Ok(Some((
                kunde,
                QrPreview {
                    path: preview_path.to_string_lossy().to_string(),
                    width,
                    height,
                    spotlight,
                },
            )))
        }
        Err(e) => {
            // QR found but not a valid customer payload — treat as miss for this frame.
            eprintln!("QR found but parse failed: {e}");
            Ok(None)
        }
    }
}

/// Scan a photo file for a customer QR code.
pub fn scan_photo(
    ffmpeg: &Path,
    path: &str,
    options: &QrScanOptions,
    cancel: Option<&AtomicBool>,
) -> Result<QrScanResult, QrScanError> {
    let _ = ffmpeg; // photo decode uses image crate; ffmpeg kept for API symmetry
    if is_stop(cancel) {
        return Ok(QrScanResult::cancelled());
    }
    if !Path::new(path).is_file() {
        return Err(QrScanError::NotFound(path.to_string()));
    }

    match decode_kunde_from_image_path(Path::new(path), options.max_photo_width)? {
        Some((kunde, preview)) => Ok(QrScanResult::hit(kunde, path, Some(preview))),
        None => Ok(QrScanResult::miss(format!(
            "Kein gültiger QR-Code im Foto: {path}"
        ))),
    }
}

/// Scan the first `scan_seconds` of a video clip for a customer QR code.
pub fn scan_video_clip(
    ffmpeg: &Path,
    path: &str,
    options: &QrScanOptions,
    cancel: Option<&AtomicBool>,
) -> Result<QrScanResult, QrScanError> {
    if is_stop(cancel) {
        return Ok(QrScanResult::cancelled());
    }
    if !Path::new(path).is_file() {
        return Err(QrScanError::NotFound(path.to_string()));
    }

    let meta = probe::probe_video(ffmpeg, path)?;
    let fps = if meta.fps > 0.0 { meta.fps } else { 30.0 };
    let indices = target_frame_indices(fps, options.scan_seconds, options.frame_step);

    let tmp_dir = tempfile::tempdir().map_err(|e| QrScanError::Message(e.to_string()))?;
    let frame_path: PathBuf = tmp_dir.path().join("qr_frame.png");
    let frame_str = frame_path.to_string_lossy().to_string();

    let mut frames_read = 0u32;
    for frame_index in indices {
        if is_stop(cancel) {
            return Ok(QrScanResult::cancelled());
        }

        let seek_secs = frame_index as f64 / fps;
        let args =
            build_extract_frame_args(path, seek_secs, &frame_str, options.max_video_width);
        match run_ffmpeg_checked(ffmpeg, &args) {
            Ok(()) => {}
            Err(FfmpegError::Cancelled) => return Ok(QrScanResult::cancelled()),
            Err(_) => continue,
        }

        if !frame_path.is_file() {
            continue;
        }
        frames_read += 1;

        if let Some((kunde, preview)) =
            decode_kunde_from_image_path(&frame_path, options.max_video_width)?
        {
            return Ok(QrScanResult::hit(kunde, path, Some(preview)));
        }
    }

    // Sequential fallback: extract frames at 1/fps cadence without relying on seek accuracy.
    if frames_read == 0 {
        let frames_limit =
            ((fps * options.scan_seconds.max(0.5)) as u32).max(1);
        let step = options.frame_step.max(1);
        for frame_index in (0..frames_limit).step_by(step as usize) {
            if is_stop(cancel) {
                return Ok(QrScanResult::cancelled());
            }
            let seek_secs = frame_index as f64 / fps;
            // Place -ss after -i for more accurate sequential-style sampling.
            let args = build_extract_frame_args_accurate(
                path,
                seek_secs,
                &frame_str,
                options.max_video_width,
            );
            if run_ffmpeg_checked(ffmpeg, &args).is_err() {
                continue;
            }
            if !frame_path.is_file() {
                continue;
            }
            if let Some((kunde, preview)) =
                decode_kunde_from_image_path(&frame_path, options.max_video_width)?
            {
                return Ok(QrScanResult::hit(kunde, path, Some(preview)));
            }
        }
    }

    Ok(QrScanResult::miss(format!(
        "Kein gültiger QR-Code in den ersten {:.0}s: {path}",
        options.scan_seconds
    )))
}

/// Accurate seek variant (input before seek) for sequential fallback.
pub fn build_extract_frame_args_accurate(
    input: &str,
    seek_secs: f64,
    output_png: &str,
    max_width: u32,
) -> Vec<String> {
    let seek = format!("{:.3}", seek_secs.max(0.0));
    let vf = format!("scale='min({max_width},iw)':-1");
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        input.to_string(),
        "-ss".into(),
        seek,
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf,
        "-y".into(),
        output_png.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_frame_indices_includes_zero_and_steps() {
        let idx = target_frame_indices(30.0, 5.0, 10);
        assert_eq!(idx.first(), Some(&0));
        assert!(idx.contains(&10));
        assert!(idx.contains(&140) || idx.last() == Some(&140) || idx.contains(&140));
        // 30*5=150 frames → 0,10,...,140
        assert_eq!(idx, vec![0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140]);
    }

    #[test]
    fn target_frame_indices_handles_zero_fps() {
        let idx = target_frame_indices(0.0, 1.0, 10);
        assert_eq!(idx.first(), Some(&0));
        assert!(!idx.is_empty());
    }

    #[test]
    fn build_extract_frame_args_order() {
        let args = build_extract_frame_args("in.mp4", 1.5, "out.png", 1280);
        assert_eq!(args[0], "-hide_banner");
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "fast seek should be before -i");
        assert!(args.contains(&"1.500".to_string()));
        assert!(args.iter().any(|a| a.contains("1280")));
        assert_eq!(args.last().map(String::as_str), Some("out.png"));
    }

    #[test]
    fn build_extract_frame_args_accurate_seek_after_input() {
        let args = build_extract_frame_args_accurate("in.mp4", 0.5, "out.png", 1280);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(i < ss, "accurate seek should be after -i");
    }

    #[test]
    fn parse_kunde_url_fragment_json() {
        let payload = r#"https://example.com/app#{"Customer_ID":"abc123","Booking_ID":"b1","vorname":"Max","nachname":"Mustermann","media":"hc_fv"}"#;
        let k = parse_kunde_from_qr_string(payload).unwrap();
        assert_eq!(k.kunden_id_hash.as_deref(), Some("abc123"));
        assert_eq!(k.booking_id_hash.as_deref(), Some("b1"));
        assert_eq!(k.vorname.as_deref(), Some("Max"));
        assert_eq!(k.nachname.as_deref(), Some("Mustermann"));
        assert!(k.handcam_foto && k.handcam_video);
        assert!(!k.outside_foto && !k.outside_video);
        assert_eq!(k.video_mode, "handcam");
        assert_eq!(k.form_mode, "kunde");
        assert_eq!(k.gast, "Max Mustermann");
    }

    #[test]
    fn parse_kunde_raw_json_outside() {
        let payload = r#"{"customer_id":"x","vorname":"Anna","nachname":"S","media":"ou_v"}"#;
        let k = parse_kunde_from_qr_string(payload).unwrap();
        assert!(k.outside_video && !k.outside_foto);
        assert_eq!(k.video_mode, "outside");
    }

    #[test]
    fn parse_kunde_unknown_media() {
        let payload = r#"{"Customer_ID":"x","vorname":"A","nachname":"B","media":"nope"}"#;
        assert!(parse_kunde_from_qr_string(payload).is_err());
    }

    #[test]
    fn parse_kunde_missing_id() {
        let payload = r#"{"vorname":"A","nachname":"B","media":"none"}"#;
        assert!(parse_kunde_from_qr_string(payload).is_err());
    }

    #[test]
    fn parse_kunde_empty_media_defaults_none() {
        let payload = r#"{"hashid":"h1","vorname":"A","nachname":"B","media":""}"#;
        let k = parse_kunde_from_qr_string(payload).unwrap();
        assert!(!k.handcam_foto && !k.handcam_video);
        assert_eq!(k.video_mode, "");
    }

    #[test]
    fn spotlight_from_points_makes_padded_square() {
        let pts = [(100.0, 100.0), (100.0, 200.0), (200.0, 100.0), (200.0, 200.0)];
        let spot = spotlight_from_points(&pts, 1000, 800).unwrap();
        // AABB 100×100 → side 120 with 20% pad; center (150,150)
        assert!((spot.size - 0.12).abs() < 1e-4, "size={}", spot.size);
        assert!((spot.x - 0.09).abs() < 1e-4, "x={}", spot.x); // (150-60)/1000
        assert!((spot.y - 0.1125).abs() < 1e-4, "y={}", spot.y); // (150-60)/800
    }

    #[test]
    fn spotlight_from_points_empty_is_none() {
        assert!(spotlight_from_points(&[], 100, 100).is_none());
    }

    #[test]
    fn discard_qr_preview_removes_dir() {
        let dir = std::env::temp_dir().join(format!(
            "{QR_PREVIEW_DIR_PREFIX}test_{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hit.png");
        fs::write(&file, b"x").unwrap();
        discard_qr_preview(file.to_str().unwrap()).unwrap();
        assert!(!file.exists());
        assert!(!dir.exists());
    }
}
