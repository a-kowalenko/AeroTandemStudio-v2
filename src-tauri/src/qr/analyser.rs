//! QR analyser — FFmpeg frame extraction + rxing decode + JSON → `Kunde`.
//!
//! Behaviour port of legacy `qr_analyser.py` (without OpenCV / pyzbar).

use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageBuffer};
use jpeg_decoder::{Decoder as JpegDecoder, PixelFormat as JpegPixelFormat};
use rxing::common::HybridBinarizer;
use rxing::{
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource, MultiFormatReader, Reader,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::Kunde;
use crate::storage::logging;
use crate::video::ffmpeg::{self, run_ffmpeg_checked, run_ffmpeg_raw_stdout_frames, FfmpegError};
use crate::video::probe;

pub const DEFAULT_QR_VIDEO_SCAN_SECONDS: f64 = 5.0;
pub const DEFAULT_QR_FRAME_STEP: u32 = 10;
pub const MAX_QR_DECODE_WIDTH: u32 = 1920;
pub const MAX_QR_VIDEO_DECODE_WIDTH: u32 = 1280;
/// Downscale for follow-up neighbor scans (detect-only, no preview).
pub const MAX_QR_FOLLOWUP_DECODE_WIDTH: u32 = 960;
/// Lower width for the quick first-pass detect (faster FFmpeg + rxing).
pub const QR_FAST_DETECT_WIDTH: u32 = 960;
/// Cascade pass 1 — cheap rxing at reduced width (no `TryHarder`).
pub const QR_CASCADE_CHEAP_WIDTH: u32 = 640;
/// Cascade pass 2 — normal width with `TryHarder` on miss.
pub const QR_CASCADE_NORMAL_WIDTH: u32 = 960;
/// Cascade pass 4 — escalate width after preprocess miss.
pub const QR_CASCADE_ESCALATE_WIDTH: u32 = 1280;
/// Laplacian-variance below this → skip expensive rxing (video pipe).
pub const QR_SHARPNESS_GATE_THRESHOLD: f64 = 20.0;
/// Always try at least this many sharpest buffered frames even when below threshold.
pub const QR_SHARPNESS_GATE_MIN_KEEP: usize = 3;
/// Midpoint anchors tried via cheap PNG before the full pipe (0, last, mid…).
pub const QR_QUICK_ANCHOR_COUNT: usize = 3;
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QrSpotlight {
    pub x: f32,
    pub y: f32,
    pub size: f32,
}

/// Persisted hit-frame (or decode image) for the success dialog / Vorgang history.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Second rxing pass (`TryHarder`) after a cheap miss. Off for photo batches.
    pub photo_try_harder: bool,
}

impl Default for QrScanOptions {
    fn default() -> Self {
        Self {
            scan_seconds: DEFAULT_QR_VIDEO_SCAN_SECONDS,
            frame_step: DEFAULT_QR_FRAME_STEP,
            max_video_width: MAX_QR_VIDEO_DECODE_WIDTH,
            // 960 so JPEG IDCT can often pick 1/4 instead of 1/2, and rxing stays cheap.
            max_photo_width: QR_FAST_DETECT_WIDTH,
            photo_try_harder: false,
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
    let vf = format!("scale='min({max_width},iw)':-2:flags=fast_bilinear");
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
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        vf,
        "-y".into(),
        output_png.to_string(),
    ]
}

/// Effective sampling rate for batch QR extract (`fps / frame_step`).
pub fn sample_fps_for_qr(fps: f64, frame_step: u32) -> f64 {
    let fps = if fps > 0.0 { fps } else { 30.0 };
    let step = f64::from(frame_step.max(1));
    (fps / step).max(0.5)
}

/// Expected frame count for a select-step window (same as [`target_frame_indices`]).
pub fn expected_qr_frame_count(scan_seconds: f64, sample_fps: f64) -> u32 {
    let n = (sample_fps.max(0.5) * scan_seconds.max(0.5)).ceil() as u32;
    n.max(1)
}

/// Output size for `scale=W:H` (even dimensions, aspect-preserving).
pub fn scaled_gray_frame_size(src_w: u32, src_h: u32, max_width: u32) -> Option<(u32, u32)> {
    if src_w == 0 || src_h == 0 {
        return None;
    }
    let mut out_w = max_width.min(src_w);
    out_w = (out_w / 2) * 2;
    if out_w < 2 {
        out_w = 2;
    }
    let mut out_h = ((u64::from(src_h) * u64::from(out_w)) / u64::from(src_w)) as u32;
    out_h = (out_h / 2) * 2;
    if out_h < 2 {
        out_h = 2;
    }
    Some((out_w, out_h))
}

/// One-shot FFmpeg args: same frame indices as seek fallback (`0, step, 2*step, …`).
///
/// Uses `select=not(mod(n\,step))` + `fps_mode=vfr` so timestamps match
/// [`target_frame_indices`] — the old `fps=` filter picked different frames and
/// missed QRs that seek/PNG still found (e.g. src_frame 130 @ ~4.3s).
/// Output is single-channel gray (no RGB→luma conversion in Rust).
pub fn build_extract_frames_pipe_args(
    input: &str,
    scan_seconds: f64,
    frame_step: u32,
    out_w: u32,
    out_h: u32,
) -> Vec<String> {
    let t = format!("{:.3}", scan_seconds.max(0.5));
    let step = frame_step.max(1);
    // Escape comma for FFmpeg filtergraph (same style as keyframe select elsewhere).
    let vf = format!(
        "select='not(mod(n\\,{step}))',scale={out_w}:{out_h}:flags=fast_bilinear,format=gray"
    );
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        "0".into(),
        "-t".into(),
        t,
        "-i".into(),
        input.to_string(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        vf,
        "-fps_mode".into(),
        "vfr".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "gray".into(),
        "-".into(),
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

/// Decode order over candidate **slots** (indices into [`target_frame_indices`]).
///
/// Strategy (no left-half bias — symmetric midpoint subdivision):
/// 1. slot 0 first (clip start)
/// 2. last, then mid of the full range
/// 3. further midpoints of open gaps (larger gap first; ties alternate)
pub fn midpoint_decode_order(n: usize) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    let mut order = Vec::with_capacity(n);
    let mut visited = vec![false; n];

    order.push(0);
    visited[0] = true;
    if n == 1 {
        return order;
    }

    let last = n - 1;
    if !visited[last] {
        order.push(last);
        visited[last] = true;
    }
    if order.len() == n {
        return order;
    }

    let mut queue = VecDeque::new();
    queue.push_back((0usize, last));

    while let Some((lo, hi)) = queue.pop_front() {
        if hi <= lo + 1 {
            continue;
        }
        let mid = lo + (hi - lo) / 2;
        if !visited[mid] {
            order.push(mid);
            visited[mid] = true;
        }
        let left_span = mid - lo;
        let right_span = hi - mid;
        if right_span > left_span {
            queue.push_back((mid, hi));
            queue.push_back((lo, mid));
        } else if left_span > right_span {
            queue.push_back((lo, mid));
            queue.push_back((mid, hi));
        } else if mid % 2 == 0 {
            // Equal spans: alternate to avoid a systematic left bias.
            queue.push_back((mid, hi));
            queue.push_back((lo, mid));
        } else {
            queue.push_back((lo, mid));
            queue.push_back((mid, hi));
        }
        if order.len() == n {
            break;
        }
    }

    for i in 0..n {
        if !visited[i] {
            order.push(i);
        }
    }
    order
}

/// Source-frame indices in [`midpoint_decode_order`] sequence.
pub fn midpoint_ordered_frames(indices: &[u32]) -> Vec<u32> {
    midpoint_decode_order(indices.len())
        .into_iter()
        .filter_map(|slot| indices.get(slot).copied())
        .collect()
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

fn clip_file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

/// Which cascade stage produced a QR hit (logged for OPT-14 acceptance).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrDecodeCascadePass {
    Cheap,
    Normal,
    PreprocessContrast,
    PreprocessInvert,
    PreprocessUnsharp,
    Escalate,
}

impl QrDecodeCascadePass {
    fn as_log_str(self) -> &'static str {
        match self {
            Self::Cheap => "cheap",
            Self::Normal => "normal",
            Self::PreprocessContrast => "preprocess_contrast",
            Self::PreprocessInvert => "preprocess_invert",
            Self::PreprocessUnsharp => "preprocess_unsharp",
            Self::Escalate => "escalate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QrCascadeMode {
    /// Photo batch: cheap + normal only (no preprocess / width escalate).
    Fast,
    /// Full cascade including preprocess and multi-scale escalate.
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QrPreprocess {
    Contrast,
    Invert,
    Unsharp,
}

/// Laplacian variance on luma (subsampled). Higher → sharper.
pub fn laplacian_variance(luma: &[u8], width: u32, height: u32) -> f64 {
    let w = width as usize;
    let h = height as usize;
    if w < 3 || h < 3 || luma.len() < w * h {
        return 0.0;
    }
    let stride = 2usize;
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut n = 0usize;
    for y in (1..h.saturating_sub(1)).step_by(stride) {
        for x in (1..w.saturating_sub(1)).step_by(stride) {
            let idx = y * w + x;
            let c = luma[idx] as i32;
            let lap = 4 * c
                - luma[idx - 1] as i32
                - luma[idx + 1] as i32
                - luma[idx - w] as i32
                - luma[idx + w] as i32;
            let lf = lap as f64;
            sum += lf;
            sum_sq += lf * lf;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    let mean = sum / n as f64;
    sum_sq / n as f64 - mean * mean
}

/// Slots allowed for rxing after the sharpness gate (anchors + top-N + above threshold).
pub fn sharpness_gate_allowed_slots(
    frame_lumas: &[(usize, f64)],
    threshold: f64,
    min_keep: usize,
) -> HashSet<usize> {
    let mut allowed = HashSet::new();
    if frame_lumas.is_empty() {
        return allowed;
    }
    // Anchor: slot 0 always tried when present.
    if frame_lumas.iter().any(|(s, _)| *s == 0) {
        allowed.insert(0);
    }
    let mut ranked = frame_lumas.to_vec();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (slot, _) in ranked.iter().take(min_keep.max(1)) {
        allowed.insert(*slot);
    }
    for (slot, score) in frame_lumas {
        if *score >= threshold {
            allowed.insert(*slot);
        }
    }
    allowed
}

fn apply_qr_preprocess(luma: &[u8], width: u32, height: u32, kind: QrPreprocess) -> Vec<u8> {
    match kind {
        QrPreprocess::Contrast => contrast_stretch_luma(luma),
        QrPreprocess::Invert => luma.iter().map(|p| 255 - p).collect(),
        QrPreprocess::Unsharp => unsharp_luma(luma, width, height),
    }
}

fn contrast_stretch_luma(luma: &[u8]) -> Vec<u8> {
    let Some(&min_v) = luma.iter().min() else {
        return Vec::new();
    };
    let Some(&max_v) = luma.iter().max() else {
        return Vec::new();
    };
    if max_v == min_v {
        return luma.to_vec();
    }
    let span = (max_v - min_v) as f32;
    luma.iter()
        .map(|&p| (((p - min_v) as f32 / span) * 255.0).round() as u8)
        .collect()
}

fn unsharp_luma(luma: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    if w < 3 || h < 3 || luma.len() < w * h {
        return luma.to_vec();
    }
    let mut out = luma.to_vec();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let idx = y * w + x;
            let blur = (luma[idx - 1] as u16
                + luma[idx + 1] as u16
                + luma[idx - w] as u16
                + luma[idx + w] as u16
                + luma[idx] as u16)
                / 5;
            let sharp = (luma[idx] as f32 + 0.6 * (luma[idx] as f32 - blur as f32))
                .round()
                .clamp(0.0, 255.0) as u8;
            out[idx] = sharp;
        }
    }
    out
}

/// Widths tried in order for multi-scale cascade (deduped, capped by `max_escalate`).
/// Never upscales beyond `orig_w`.
pub fn cascade_target_widths(max_escalate: u32, orig_w: u32) -> Vec<u32> {
    let cap = max_escalate.max(1).min(MAX_QR_DECODE_WIDTH);
    let orig_w = orig_w.max(1).min(cap);
    if orig_w <= QR_CASCADE_CHEAP_WIDTH {
        return vec![orig_w];
    }
    let candidates = [
        QR_CASCADE_CHEAP_WIDTH,
        QR_CASCADE_NORMAL_WIDTH,
        QR_CASCADE_ESCALATE_WIDTH,
        MAX_QR_DECODE_WIDTH,
    ];
    let mut widths: Vec<u32> = candidates
        .iter()
        .map(|&w| w.min(cap).min(orig_w))
        .collect();
    widths.sort();
    widths.dedup();
    if widths.is_empty() {
        widths.push(orig_w);
    }
    widths
}

/// Decode QR text + corner points from a greyscale luma8 buffer (full cascade).
pub fn decode_qr_from_luma(
    luma: Vec<u8>,
    width: u32,
    height: u32,
) -> Option<(String, Vec<(f32, f32)>)> {
    decode_qr_cascade_from_luma(luma, width, height, QrCascadeMode::Full, None)
        .map(|h| (h.text, h.points))
}

fn decode_qr_cascade_from_luma(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    mode: QrCascadeMode,
    escalate_pass: Option<QrDecodeCascadePass>,
) -> Option<QrLumaHit> {
    // Pass 1 — cheap (no TryHarder).
    if let Some(hit) = decode_qr_from_luma_hints(luma.clone(), width, height, false) {
        return Some(QrLumaHit {
            text: hit.0,
            points: hit.1,
            pass: escalate_pass.unwrap_or(QrDecodeCascadePass::Cheap),
        });
    }
    // Pass 2 — normal + TryHarder.
    if let Some(hit) = decode_qr_from_luma_hints(luma.clone(), width, height, true) {
        return Some(QrLumaHit {
            text: hit.0,
            points: hit.1,
            pass: escalate_pass.unwrap_or(QrDecodeCascadePass::Normal),
        });
    }
    if mode == QrCascadeMode::Fast {
        return None;
    }
    // Pass 3 — preprocess variants.
    let preps = [
        (QrPreprocess::Contrast, QrDecodeCascadePass::PreprocessContrast),
        (QrPreprocess::Invert, QrDecodeCascadePass::PreprocessInvert),
        (QrPreprocess::Unsharp, QrDecodeCascadePass::PreprocessUnsharp),
    ];
    for (prep, pass) in preps {
        let processed = apply_qr_preprocess(&luma, width, height, prep);
        if let Some(hit) = decode_qr_from_luma_hints(processed, width, height, true) {
            return Some(QrLumaHit {
                text: hit.0,
                points: hit.1,
                pass: escalate_pass.unwrap_or(pass),
            });
        }
    }
    None
}

struct QrLumaHit {
    text: String,
    points: Vec<(f32, f32)>,
    pass: QrDecodeCascadePass,
}

fn log_qr_decode_pass(pass: QrDecodeCascadePass, width: u32, height: u32) {
    logging::debug(
        "qr",
        format!(
            "QR decode hit pass={} size={width}x{height}",
            pass.as_log_str()
        ),
    );
}

fn decode_qr_from_luma_hints(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
) -> Option<(String, Vec<(f32, f32)>)> {
    if width == 0 || height == 0 || luma.len() < (width as usize) * (height as usize) {
        return None;
    }

    let source = Luma8LuminanceSource::new(luma, width, height).ok()?;
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
    let mut hints = DecodeHints::default();
    hints.PossibleFormats = Some(HashSet::from([BarcodeFormat::QR_CODE]));
    hints.TryHarder = Some(try_harder);

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

/// Load image for QR: JPEG uses DCT-scaled decode (1/2, 1/4, 1/8) toward `max_width`
/// so multi-MP files are not fully materialised. Other formats fall back to `image::open`.
fn open_image_for_qr(path: &Path, max_width: u32) -> Result<DynamicImage, QrScanError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "jpg" | "jpeg") {
        match open_jpeg_scaled(path, max_width) {
            Ok(img) => return Ok(img),
            Err(e) => {
                eprintln!(
                    "JPEG scaled decode failed ({}, fallback to full decode): {e}",
                    path.display()
                );
            }
        }
    }
    image::open(path).map_err(|e| QrScanError::Image(e.to_string()))
}

fn open_jpeg_scaled(path: &Path, max_width: u32) -> Result<DynamicImage, QrScanError> {
    let file = File::open(path).map_err(|e| QrScanError::Image(e.to_string()))?;
    let mut decoder = JpegDecoder::new(BufReader::new(file));
    decoder
        .read_info()
        .map_err(|e| QrScanError::Image(format!("JPEG header: {e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| QrScanError::Image("JPEG missing info after header".into()))?;

    let max_w = max_width
        .max(1)
        .min(MAX_QR_DECODE_WIDTH)
        .min(u32::from(u16::MAX));
    let req_w = max_w as u16;
    let req_h = if info.width > 0 {
        let h = (u64::from(max_w) * u64::from(info.height) / u64::from(info.width)).max(1);
        h.min(u64::from(u16::MAX)) as u16
    } else {
        req_w
    };

    // Efficient IDCT downscale: factors 1/8, 1/4, 1/2, 1 — picks the smallest that
    // still yields ≥ requested size on at least one axis.
    decoder
        .scale(req_w, req_h.max(1))
        .map_err(|e| QrScanError::Image(format!("JPEG scale: {e}")))?;

    let pixels = decoder
        .decode()
        .map_err(|e| QrScanError::Image(format!("JPEG decode: {e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| QrScanError::Image("JPEG missing info after decode".into()))?;
    let w = u32::from(info.width);
    let h = u32::from(info.height);

    let img = match info.pixel_format {
        JpegPixelFormat::L8 => {
            let buf = ImageBuffer::<image::Luma<u8>, _>::from_raw(w, h, pixels)
                .ok_or_else(|| QrScanError::Image("JPEG L8 buffer size mismatch".into()))?;
            DynamicImage::ImageLuma8(buf)
        }
        JpegPixelFormat::RGB24 => {
            let buf = ImageBuffer::<image::Rgb<u8>, _>::from_raw(w, h, pixels)
                .ok_or_else(|| QrScanError::Image("JPEG RGB buffer size mismatch".into()))?;
            DynamicImage::ImageRgb8(buf)
        }
        other => {
            return Err(QrScanError::Image(format!(
                "JPEG pixel format {other:?} unsupported for scaled path"
            )));
        }
    };
    Ok(img)
}

/// Load image path, optionally downscale, convert to luma, decode QR → Kunde + preview.
pub fn decode_kunde_from_image_path(
    path: &Path,
    max_width: u32,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    decode_kunde_from_image_path_ex(path, max_width, true, true)
}

fn decode_kunde_from_image_path_ex(
    path: &Path,
    max_width: u32,
    persist_preview: bool,
    allow_try_harder: bool,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    let img = open_image_for_qr(path, max_width)?;
    decode_kunde_from_dynamic_image(img, max_width, persist_preview, allow_try_harder)
}

/// Detect a valid customer QR without persisting a preview image (follow-up cleanup).
pub fn photo_has_customer_qr(path: &Path, max_width: u32) -> Result<bool, QrScanError> {
    Ok(decode_kunde_from_image_path_ex(path, max_width, false, true)?.is_some())
}

fn decode_kunde_from_dynamic_image(
    img: image::DynamicImage,
    max_width: u32,
    persist_preview: bool,
    allow_escalate: bool,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    let (orig_w, _orig_h) = img.dimensions();
    let mode = if allow_escalate {
        QrCascadeMode::Full
    } else {
        QrCascadeMode::Fast
    };
    let widths = cascade_target_widths(max_width, orig_w);

    let mut hit_img: Option<image::DynamicImage> = None;
    let mut hit_luma: Option<QrLumaHit> = None;
    let mut hit_dims = (0u32, 0u32);

    for (wi, &target_w) in widths.iter().enumerate() {
        let scaled = if orig_w > target_w {
            img.resize(target_w, u32::MAX, FilterType::Triangle)
        } else {
            img.clone()
        };
        let gray = scaled.to_luma8();
        let width = gray.width();
        let height = gray.height();
        let luma = gray.into_raw();

        let escalate_pass = if wi > 0 {
            Some(QrDecodeCascadePass::Escalate)
        } else {
            None
        };
        if let Some(h) = decode_qr_cascade_from_luma(luma, width, height, mode, escalate_pass) {
            log_qr_decode_pass(h.pass, width, height);
            hit_img = Some(scaled);
            hit_dims = (width, height);
            hit_luma = Some(h);
            break;
        }
    }

    let Some(hit) = hit_luma else {
        return Ok(None);
    };
    let (width, height) = hit_dims;
    let preview_img = hit_img.unwrap_or_else(|| img.clone());

    match parse_kunde_from_qr_string(&hit.text) {
        Ok(kunde) => {
            if !persist_preview {
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
            let preview_path = persist_qr_preview_image(&preview_img)?;
            let spotlight = spotlight_from_points(&hit.points, width, height);
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

    match decode_kunde_from_image_path_ex(
        Path::new(path),
        options.max_photo_width,
        true,
        options.photo_try_harder,
    )? {
        Some((kunde, preview)) => Ok(QrScanResult::hit(kunde, path, Some(preview))),
        None => Ok(QrScanResult::miss(format!(
            "Kein gültiger QR-Code im Foto: {path}"
        ))),
    }
}

/// Gray frame → cascade decode (pipe outputs `format=gray`).
fn decode_kunde_from_gray_frame(
    gray: &[u8],
    width: u32,
    height: u32,
    persist_preview: bool,
    allow_escalate: bool,
) -> Result<Option<(Kunde, QrPreview)>, QrScanError> {
    let needed = (width as usize).saturating_mul(height as usize);
    if gray.len() < needed {
        return Err(QrScanError::Image(format!(
            "gray buffer too small: got {} need {needed}",
            gray.len()
        )));
    }
    let luma = gray[..needed].to_vec();
    let mode = if allow_escalate {
        QrCascadeMode::Full
    } else {
        QrCascadeMode::Fast
    };
    let Some(hit) = decode_qr_cascade_from_luma(luma, width, height, mode, None) else {
        return Ok(None);
    };
    log_qr_decode_pass(hit.pass, width, height);

    let buf = ImageBuffer::<image::Luma<u8>, _>::from_raw(width, height, gray[..needed].to_vec())
        .ok_or_else(|| QrScanError::Image("gray buffer size mismatch".into()))?;
    let img = DynamicImage::ImageLuma8(buf);

    match parse_kunde_from_qr_string(&hit.text) {
        Ok(kunde) => {
            if !persist_preview {
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
            let spotlight = spotlight_from_points(&hit.points, width, height);
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
            eprintln!("QR found but parse failed: {e}");
            Ok(None)
        }
    }
}

/// Optional progress: `(path, phase, frame, frames_total)`.
/// Phases: `start` | `done` | `hit` | `extract` | `fast` | `thorough`.
/// - `extract`: one-shot pipe is buffering samples (no Prüfpunkt counter)
/// - `fast`: midpoint decode on buffered pipe frames (Schnellprüfung)
/// - `thorough`: per-frame seek/PNG fallback (gründliche Prüfung)
pub type QrScanProgressCb<'a> = dyn Fn(&str, &str, u32, u32) + Sync + 'a;

/// Scan the first `scan_seconds` of a video clip for a customer QR code.
pub fn scan_video_clip(
    ffmpeg: &Path,
    path: &str,
    options: &QrScanOptions,
    cancel: Option<&AtomicBool>,
) -> Result<QrScanResult, QrScanError> {
    scan_video_clip_with_progress(ffmpeg, path, options, cancel, None)
}

/// Like [`scan_video_clip`], with optional progress (`extract` / `fast` / `thorough`).
///
/// Fast path: cheap PNG midpoint anchors (0 / last / mid), then one FFmpeg pipe
/// with `fast_bilinear` extract + midpoint decode. Seek/PNG fallback last.
pub fn scan_video_clip_with_progress(
    ffmpeg: &Path,
    path: &str,
    options: &QrScanOptions,
    cancel: Option<&AtomicBool>,
    on_progress: Option<&QrScanProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError> {
    if is_stop(cancel) {
        return Ok(QrScanResult::cancelled());
    }
    if !Path::new(path).is_file() {
        return Err(QrScanError::NotFound(path.to_string()));
    }

    // Early UI signal before probe/FFmpeg spawn so the stripe leaves "idle" sooner.
    if let Some(cb) = on_progress {
        cb(path, "extract", 0, 1);
    }

    let meta = probe::probe_video(ffmpeg, path)?;
    let fps = if meta.fps > 0.0 { meta.fps } else { 30.0 };
    let full_secs = options.scan_seconds.max(0.5);
    let full_step = options.frame_step.max(1);
    let indices = target_frame_indices(fps, full_secs, full_step);
    let frames_total = (indices.len() as u32).max(1);

    // 1) Quick PNG anchors (typically frame 0, last, mid) — fastest path to first hit.
    let (quick_hit, tried_slots) = try_quick_anchor_pass(
        ffmpeg,
        path,
        &indices,
        fps,
        frames_total,
        QR_FAST_DETECT_WIDTH.min(options.max_video_width.max(2)),
        cancel,
        on_progress,
    )?;
    if let Some(res) = quick_hit {
        return Ok(res);
    }
    if is_stop(cancel) {
        return Ok(QrScanResult::cancelled());
    }

    let out_size = scaled_gray_frame_size(meta.width, meta.height, options.max_video_width);

    if let Some((out_w, out_h)) = out_size {
        match scan_video_pipe_pass(
            ffmpeg,
            path,
            full_secs,
            full_step,
            fps,
            out_w,
            out_h,
            &tried_slots,
            cancel,
            on_progress,
        )? {
            PipePassOutcome::Hit(res) | PipePassOutcome::Cancelled(res) => return Ok(res),
            PipePassOutcome::Miss { frames_read } => {
                logging::info(
                    "qr",
                    format!(
                        "Pipe midpoint miss frames={frames_read} → Seek/PNG-Fallback file={}",
                        clip_file_name(path)
                    ),
                );
            }
            PipePassOutcome::PipeFailed => {
                logging::info(
                    "qr",
                    format!(
                        "Pipe failed → Seek/PNG-Fallback file={}",
                        clip_file_name(path)
                    ),
                );
            }
        }

        if is_stop(cancel) {
            return Ok(QrScanResult::cancelled());
        }
    } else {
        logging::debug(
            "qr",
            format!(
                "Keine Pipe-Größe (Probe {}x{}) → Seek/PNG file={}",
                meta.width,
                meta.height,
                clip_file_name(path)
            ),
        );
    }

    // Legacy fallback: per-frame seek extract (PNG on disk) — also after a clean pipe miss.
    scan_video_clip_seek_fallback(ffmpeg, path, options, cancel, fps, on_progress)
}

/// Cheap PNG extracts for the first midpoint anchors (usually 0, last, mid).
/// Returns `(hit, slots_already_tried)`.
fn try_quick_anchor_pass(
    ffmpeg: &Path,
    path: &str,
    indices: &[u32],
    fps: f64,
    frames_total: u32,
    max_width: u32,
    cancel: Option<&AtomicBool>,
    on_progress: Option<&QrScanProgressCb<'_>>,
) -> Result<(Option<QrScanResult>, HashSet<usize>), QrScanError> {
    let mut tried = HashSet::new();
    if indices.is_empty() {
        return Ok((None, tried));
    }
    let order = midpoint_decode_order(indices.len());
    let quick_n = order.len().min(QR_QUICK_ANCHOR_COUNT);
    if quick_n == 0 {
        return Ok((None, tried));
    }

    let notify = |phase: &str, frame: u32, total: u32| {
        if let Some(cb) = on_progress {
            cb(path, phase, frame, total);
        }
    };

    let tmp_dir = tempfile::tempdir().map_err(|e| QrScanError::Message(e.to_string()))?;
    let frame_path: PathBuf = tmp_dir.path().join("qr_quick.png");
    let frame_str = frame_path.to_string_lossy().to_string();

    for (i, &slot) in order.iter().take(quick_n).enumerate() {
        if is_stop(cancel) {
            return Ok((Some(QrScanResult::cancelled()), tried));
        }
        tried.insert(slot);
        let frame_index = indices[slot];
        let seek_secs = frame_index as f64 / fps;
        let attempt = (i as u32).saturating_add(1);
        notify("fast", attempt, frames_total);

        let args = build_extract_frame_args(path, seek_secs, &frame_str, max_width);
        match run_ffmpeg_checked(ffmpeg, &args) {
            Ok(()) => {}
            Err(FfmpegError::Cancelled) => {
                return Ok((Some(QrScanResult::cancelled()), tried));
            }
            Err(_) => continue,
        }
        if !frame_path.is_file() {
            continue;
        }

        if let Some((kunde, preview)) = decode_kunde_from_image_path(&frame_path, max_width)? {
            logging::info(
                "qr",
                format!(
                    "Clip-Treffer via=quick_anchor frame={attempt}/{frames_total} seek={seek_secs:.3}s src_frame={frame_index} file={}",
                    clip_file_name(path)
                ),
            );
            return Ok((
                Some(QrScanResult::hit(kunde, path, Some(preview))),
                tried,
            ));
        }
    }

    Ok((None, tried))
}

enum PipePassOutcome {
    Hit(QrScanResult),
    Cancelled(QrScanResult),
    Miss { frames_read: usize },
    PipeFailed,
}

fn scan_video_pipe_pass(
    ffmpeg: &Path,
    path: &str,
    scan_seconds: f64,
    frame_step: u32,
    fps: f64,
    out_w: u32,
    out_h: u32,
    skip_slots: &HashSet<usize>,
    cancel: Option<&AtomicBool>,
    on_progress: Option<&QrScanProgressCb<'_>>,
) -> Result<PipePassOutcome, QrScanError> {
    let indices = target_frame_indices(fps, scan_seconds, frame_step);
    if indices.is_empty() {
        return Ok(PipePassOutcome::Miss { frames_read: 0 });
    }
    let order = midpoint_decode_order(indices.len());
    let frames_total = (indices.len() as u32).max(1);
    let args = build_extract_frames_pipe_args(path, scan_seconds, frame_step, out_w, out_h);
    let frame_nbytes = (out_w as usize).saturating_mul(out_h as usize);

    let notify = |phase: &str, frame: u32, total: u32| {
        if let Some(cb) = on_progress {
            cb(path, phase, frame, total);
        }
    };

    let mut frames: Vec<Option<Vec<u8>>> = vec![None; indices.len()];
    let mut write_i = 0usize;
    let mut early: Option<QrScanResult> = None;
    let mut slot0_tried = false;

    let try_decode_slot = |slot: usize,
                           gray: &[u8],
                           attempt: u32,
                           pass_label: &str|
     -> Result<Option<QrScanResult>, QrScanError> {
        let src_frame = indices.get(slot).copied().unwrap_or(0);
        match decode_kunde_from_gray_frame(gray, out_w, out_h, true, true) {
            Ok(Some((kunde, preview))) => {
                logging::info(
                    "qr",
                    format!(
                        "Clip-Treffer via={pass_label} frame={attempt}/{frames_total} src_frame={src_frame} size={out_w}x{out_h} file={}",
                        clip_file_name(path)
                    ),
                );
                Ok(Some(QrScanResult::hit(kunde, path, Some(preview))))
            }
            Ok(None) => Ok(None),
            Err(e) => {
                eprintln!("QR frame decode error ({path}): {e}");
                Ok(None)
            }
        }
    };

    let pipe_result = run_ffmpeg_raw_stdout_frames(ffmpeg, &args, frame_nbytes, |frame| {
        if is_stop(cancel) {
            early = Some(QrScanResult::cancelled());
            return false;
        }
        if write_i >= frames.len() {
            return true;
        }
        frames[write_i] = Some(frame.to_vec());
        if write_i == 0 {
            notify("extract", 0, frames_total);
        } else if write_i + 1 == frames.len() || (write_i + 1) % 4 == 0 {
            notify("extract", 0, frames_total);
        }

        // Fast path: first pipe frame is slot 0 — decode immediately unless quick pass already did.
        if write_i == 0 {
            slot0_tried = true;
            if !skip_slots.contains(&0) {
                notify("fast", 1, frames_total);
                if let Ok(Some(res)) = try_decode_slot(0, frame, 1, "pipe_midpoint") {
                    early = Some(res);
                    return false;
                }
            }
        }

        write_i = write_i.saturating_add(1);
        true
    });

    match pipe_result {
        Ok(frames_read) => {
            if let Some(res) = early {
                if res.cancelled {
                    return Ok(PipePassOutcome::Cancelled(res));
                }
                return Ok(PipePassOutcome::Hit(res));
            }
            if is_stop(cancel) {
                return Ok(PipePassOutcome::Cancelled(QrScanResult::cancelled()));
            }

            // Sharpness gate: skip blurry frames but keep anchors + top-N sharpest.
            let sharpness_scored: Vec<(usize, f64)> = frames
                .iter()
                .enumerate()
                .filter_map(|(slot, f)| {
                    let gray = f.as_deref()?;
                    Some((slot, laplacian_variance(gray, out_w, out_h)))
                })
                .collect();
            let gate_allowed = sharpness_gate_allowed_slots(
                &sharpness_scored,
                QR_SHARPNESS_GATE_THRESHOLD,
                QR_SHARPNESS_GATE_MIN_KEEP,
            );
            let gated_skip = sharpness_scored
                .iter()
                .filter(|(slot, score)| {
                    !gate_allowed.contains(slot) && *score < QR_SHARPNESS_GATE_THRESHOLD
                })
                .count();
            if gated_skip > 0 {
                logging::debug(
                    "qr",
                    format!(
                        "Sharpness-Gate skip={gated_skip}/{} threshold={} file={}",
                        sharpness_scored.len(),
                        QR_SHARPNESS_GATE_THRESHOLD,
                        clip_file_name(path)
                    ),
                );
            }

            let mut attempt = skip_slots.len() as u32;
            if slot0_tried && !skip_slots.contains(&0) {
                attempt = attempt.saturating_add(1);
            }
            for &slot in &order {
                if skip_slots.contains(&slot) {
                    continue;
                }
                if slot == 0 && slot0_tried {
                    continue;
                }
                if !gate_allowed.contains(&slot) {
                    continue;
                }
                if is_stop(cancel) {
                    return Ok(PipePassOutcome::Cancelled(QrScanResult::cancelled()));
                }
                let Some(gray) = frames.get(slot).and_then(|f| f.as_deref()) else {
                    continue;
                };
                attempt = attempt.saturating_add(1);
                notify("fast", attempt, frames_total);
                if let Ok(Some(res)) = try_decode_slot(slot, gray, attempt, "pipe_midpoint") {
                    return Ok(PipePassOutcome::Hit(res));
                }
            }

            Ok(PipePassOutcome::Miss {
                frames_read: frames_read.max(write_i),
            })
        }
        Err(FfmpegError::Cancelled) => Ok(PipePassOutcome::Cancelled(QrScanResult::cancelled())),
        Err(e) => {
            eprintln!("QR batch pipe failed ({path}): {e}");
            Ok(PipePassOutcome::PipeFailed)
        }
    }
}

/// Per-frame FFmpeg seek extract (PNG). Used when the batch pipe path yields 0 frames.
fn scan_video_clip_seek_fallback(
    ffmpeg: &Path,
    path: &str,
    options: &QrScanOptions,
    cancel: Option<&AtomicBool>,
    fps: f64,
    on_progress: Option<&QrScanProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError> {
    let indices = target_frame_indices(fps, options.scan_seconds, options.frame_step);
    let ordered = midpoint_ordered_frames(&indices);
    let frames_total = (ordered.len() as u32).max(1);

    let notify = |phase: &str, frame: u32, frames_total: u32| {
        if let Some(cb) = on_progress {
            cb(path, phase, frame, frames_total);
        }
    };

    let tmp_dir = tempfile::tempdir().map_err(|e| QrScanError::Message(e.to_string()))?;
    let frame_path: PathBuf = tmp_dir.path().join("qr_frame.png");
    let frame_str = frame_path.to_string_lossy().to_string();

    // Signal pass change before the first thorough attempt (UI resets counter with new mode).
    notify("thorough", 0, frames_total);

    let mut frames_read = 0u32;
    for (i, frame_index) in ordered.iter().enumerate() {
        if is_stop(cancel) {
            return Ok(QrScanResult::cancelled());
        }

        let seek_secs = *frame_index as f64 / fps;
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
        notify("thorough", (i as u32).saturating_add(1), frames_total);

        if let Some((kunde, preview)) =
            decode_kunde_from_image_path(&frame_path, options.max_video_width)?
        {
            logging::info(
                "qr",
                format!(
                    "Clip-Treffer via=seek_png frame={}/{} seek={seek_secs:.3}s src_frame={frame_index} file={}",
                    (i as u32).saturating_add(1),
                    frames_total,
                    clip_file_name(path)
                ),
            );
            return Ok(QrScanResult::hit(kunde, path, Some(preview)));
        }
    }

    // Accurate-seek fallback: same midpoint order when fast seek produced nothing.
    if frames_read == 0 {
        let frames_limit = ((fps * options.scan_seconds.max(0.5)) as u32).max(1);
        let step = options.frame_step.max(1);
        let seq: Vec<u32> = (0..frames_limit).step_by(step as usize).collect();
        let ordered_seq = midpoint_ordered_frames(&seq);
        let seq_total = (ordered_seq.len() as u32).max(1);
        for (i, frame_index) in ordered_seq.iter().enumerate() {
            if is_stop(cancel) {
                return Ok(QrScanResult::cancelled());
            }
            let seek_secs = *frame_index as f64 / fps;
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
            notify("thorough", (i as u32).saturating_add(1), seq_total);
            if let Some((kunde, preview)) =
                decode_kunde_from_image_path(&frame_path, options.max_video_width)?
            {
                logging::info(
                    "qr",
                    format!(
                        "Clip-Treffer via=seek_png_accurate frame={}/{} seek={seek_secs:.3}s file={}",
                        (i as u32).saturating_add(1),
                        seq_total,
                        clip_file_name(path)
                    ),
                );
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
    fn build_extract_frames_pipe_args_select_step_gray() {
        let args = build_extract_frames_pipe_args("in.mp4", 5.0, 10, 1280, 720);
        assert_eq!(args[0], "-hide_banner");
        let i = args.iter().position(|a| a == "-i").unwrap();
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert!(t < i, "-t should be before -i for decode window");
        assert!(args.contains(&"5.000".to_string()));
        assert!(args.iter().any(|a| a.contains("not(mod(n")));
        assert!(args.iter().any(|a| a.contains("scale=1280:720")));
        assert!(args.iter().any(|a| a.contains("flags=fast_bilinear")));
        assert!(args.iter().any(|a| a.contains("format=gray")));
        assert!(args.contains(&"rawvideo".to_string()));
        assert!(args.contains(&"gray".to_string()));
        assert!(args.contains(&"-fps_mode".to_string()));
        assert!(args.contains(&"vfr".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn midpoint_decode_order_zero_last_mid_first() {
        assert_eq!(midpoint_decode_order(0), Vec::<usize>::new());
        assert_eq!(midpoint_decode_order(1), vec![0]);
        assert_eq!(midpoint_decode_order(2), vec![0, 1]);
        let o5 = midpoint_decode_order(5);
        assert_eq!(o5[0], 0);
        assert_eq!(o5[1], 4);
        assert_eq!(o5[2], 2);
        let mut sorted = o5.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn midpoint_decode_order_covers_all_no_dupes() {
        for n in 0..40 {
            let order = midpoint_decode_order(n);
            assert_eq!(order.len(), n, "n={n}");
            let mut seen = vec![false; n];
            for slot in order {
                assert!(slot < n);
                assert!(!seen[slot], "dup slot {slot} for n={n}");
                seen[slot] = true;
            }
        }
    }

    #[test]
    fn midpoint_ordered_frames_preserves_values() {
        let idx = target_frame_indices(30.0, 5.0, 10);
        let ordered = midpoint_ordered_frames(&idx);
        assert_eq!(ordered.len(), idx.len());
        assert_eq!(ordered[0], 0);
        assert_eq!(ordered[1], *idx.last().unwrap());
        let mut a = idx.clone();
        let mut b = ordered.clone();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    #[test]
    fn scaled_gray_frame_size_even_and_aspect() {
        assert_eq!(scaled_gray_frame_size(1920, 1080, 1280), Some((1280, 720)));
        assert_eq!(scaled_gray_frame_size(1000, 1000, 1280), Some((1000, 1000)));
        assert_eq!(scaled_gray_frame_size(0, 1080, 1280), None);
        // Odd source width below max → even output width
        assert_eq!(scaled_gray_frame_size(641, 480, 1280), Some((640, 478)));
    }

    #[test]
    fn sample_fps_for_qr_matches_step() {
        assert!((sample_fps_for_qr(30.0, 10) - 3.0).abs() < 1e-9);
        assert!((sample_fps_for_qr(0.0, 10) - 3.0).abs() < 1e-9); // 30/10 fallback
        assert!((sample_fps_for_qr(25.0, 0) - 25.0).abs() < 1e-9); // step max(1)
    }

    #[test]
    fn expected_qr_frame_count_ceil() {
        assert_eq!(expected_qr_frame_count(5.0, 3.0), 15);
        assert_eq!(expected_qr_frame_count(5.0, 2.5), 13);
        assert_eq!(expected_qr_frame_count(0.0, 3.0), 2); // max(0.5)*3 ceil
    }

    #[test]
    fn midpoint_prefers_ends_and_center_over_linear() {
        let order = midpoint_decode_order(15);
        // After 0 and last, center (~7) should appear before deep linear neighbors like 1.
        let pos = |s: usize| order.iter().position(|&x| x == s).unwrap();
        assert!(pos(0) < pos(7));
        assert!(pos(14) < pos(7));
        assert!(pos(7) < pos(1));
        assert!(pos(7) < pos(13));
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
    fn photo_scan_defaults_are_fast() {
        let opts = QrScanOptions::default();
        assert_eq!(opts.max_photo_width, QR_FAST_DETECT_WIDTH);
        assert!(!opts.photo_try_harder);
        assert_eq!(QR_FAST_DETECT_WIDTH, 960);
        assert!(QR_FAST_DETECT_WIDTH < MAX_QR_DECODE_WIDTH);
    }

    #[test]
    fn decode_qr_from_luma_rejects_empty() {
        assert!(decode_qr_from_luma(vec![], 0, 0).is_none());
        assert!(decode_qr_from_luma(vec![0; 4], 2, 2).is_none());
    }

    #[test]
    fn cascade_target_widths_dedupes_and_caps() {
        let w = cascade_target_widths(960, 4000);
        assert_eq!(w, vec![640, 960]);
        let w2 = cascade_target_widths(1920, 4000);
        assert_eq!(w2, vec![640, 960, 1280, 1920]);
        let w3 = cascade_target_widths(1920, 500);
        assert_eq!(w3, vec![500]);
    }

    fn synthetic_checkerboard(w: u32, h: u32, cell: u32) -> Vec<u8> {
        let mut luma = vec![0u8; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                let v = if ((x / cell) + (y / cell)) % 2 == 0 {
                    255
                } else {
                    0
                };
                luma[(y * w + x) as usize] = v;
            }
        }
        luma
    }

    fn box_blur_luma(luma: &[u8], w: u32, h: u32, radius: u32) -> Vec<u8> {
        let w = w as usize;
        let h = h as usize;
        let r = radius as usize;
        let mut out = luma.to_vec();
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0u32;
                let mut n = 0u32;
                for dy in 0..=(r * 2) {
                    let yy = y.saturating_add(dy).saturating_sub(r);
                    if yy >= h {
                        continue;
                    }
                    for dx in 0..=(r * 2) {
                        let xx = x.saturating_add(dx).saturating_sub(r);
                        if xx >= w {
                            continue;
                        }
                        sum += luma[yy * w + xx] as u32;
                        n += 1;
                    }
                }
                out[y * w + x] = (sum / n.max(1)) as u8;
            }
        }
        out
    }

    #[test]
    fn laplacian_variance_sharp_higher_than_blur() {
        let w = 64u32;
        let h = 64u32;
        let sharp = synthetic_checkerboard(w, h, 4);
        let blur = box_blur_luma(&sharp, w, h, 3);
        let v_sharp = laplacian_variance(&sharp, w, h);
        let v_blur = laplacian_variance(&blur, w, h);
        assert!(
            v_sharp > v_blur * 2.0,
            "sharp={v_sharp} blur={v_blur}"
        );
        let uniform = vec![128u8; (w * h) as usize];
        let v_uniform = laplacian_variance(&uniform, w, h);
        assert!(v_uniform < QR_SHARPNESS_GATE_THRESHOLD);
    }

    #[test]
    fn sharpness_gate_keeps_top_n_and_anchor() {
        let scores = vec![(0, 5.0), (1, 100.0), (2, 80.0), (3, 1.0), (4, 90.0)];
        let allowed = sharpness_gate_allowed_slots(&scores, 50.0, 3);
        assert!(allowed.contains(&0), "anchor slot 0");
        assert!(allowed.contains(&1));
        assert!(allowed.contains(&2));
        assert!(allowed.contains(&4));
        assert!(!allowed.contains(&3), "blur slot 3 not in top-3");
    }

    #[test]
    fn sharpness_gate_blur_slot_skipped_when_not_top_n() {
        let scores = vec![(5, 2.0), (6, 3.0), (7, 4.0), (8, 1.0)];
        let allowed = sharpness_gate_allowed_slots(&scores, 50.0, 3);
        assert_eq!(allowed.len(), 3);
        assert!(!allowed.contains(&8));
    }

    #[test]
    fn cascade_fast_mode_stops_before_preprocess() {
        let luma = vec![128u8; 64 * 64];
        assert!(
            decode_qr_cascade_from_luma(luma.clone(), 64, 64, QrCascadeMode::Fast, None).is_none()
        );
        assert!(
            decode_qr_cascade_from_luma(luma, 64, 64, QrCascadeMode::Full, None).is_none()
        );
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
