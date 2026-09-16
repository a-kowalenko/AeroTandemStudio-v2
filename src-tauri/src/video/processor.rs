//! Intro pipeline & final video creation (behaviour port of legacy `processor.py`).
//!
//! Phase 3: Hintergrund-PNG + drawtext overlay → Intro, body concat, mux.
//! Phase 4: Multi-clip body concat prep runs in parallel; progress may include `task_id`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::constants::{
    ASSET_HINTERGRUND, CONTENT_AREA_PADDING_BOTTOM, CONTENT_AREA_PADDING_LEFT,
    CONTENT_AREA_PADDING_RIGHT, CONTENT_AREA_PADDING_TOP, CONTENT_AREA_X1, CONTENT_AREA_X2,
    CONTENT_AREA_Y1, CONTENT_AREA_Y2, DEFAULT_INTRO_DAUER_SECS, HINTERGRUND_ORIGINAL_HEIGHT,
    HINTERGRUND_ORIGINAL_WIDTH,
};
use crate::model::Kunde;
use crate::storage::logging;
use super::body_concat_fallback::BodyConcatAskFn;
use super::concat::{self, ConcatError, VideoCodec};
use super::encode_profile::EncodeProfile;
use super::encoding_quality::{
    append_capcut_splice_encode_params, build_encode_output_params, majority_body_codec,
    resolve_output_codec, video_codec_to_pref_str, VideoCodecPreference,
};
use super::ffmpeg::{
    disk_full_error, ffmpeg_probe_stderr, is_cancelled, is_disk_full_error, probe_duration_secs,
    run_ffmpeg, run_ffmpeg_checked, run_ffmpeg_tagged, FfmpegError, ProgressCallback,
};
use super::hw_accel::{detect_hardware, HwAccelInfo, HwType};
use super::intro_mux_fallback::IntroMuxChoice;
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::probe;
use super::progress::{progress_from_times, progress_from_times_with_task};
use super::reencode_confirm::{
    self, ReencodeAskFn, ReencodeIntent, ReencodeKind, ReencodeParams,
};

static AUDIO_STREAM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s+Audio:\s+(\w+).*?(\d+)\s*Hz",
    )
    .unwrap()
});
static PIX_FMT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Video:\s+\w+[^,]*,\s*([a-z0-9]+)").unwrap());
static TBN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(\d+(?:\.\d+)?k?)\s*tbn").unwrap());

#[derive(Debug, Error)]
pub enum ProcessorError {
    #[error(transparent)]
    Ffmpeg(#[from] FfmpegError),
    #[error(transparent)]
    Concat(#[from] ConcatError),
    #[error(transparent)]
    Parallel(#[from] ParallelError),
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVideoOptions {
    #[serde(default = "default_intro_dauer")]
    pub dauer: f64,
    #[serde(default = "default_true")]
    pub intro_enabled: bool,
    /// Phase 50: append a user Outro (photo/video) at the very end.
    #[serde(default)]
    pub outro_enabled: bool,
    /// Absolute path to the Outro asset (photo or video). Empty ⇒ treated as disabled.
    #[serde(default)]
    pub outro_path: String,
    /// Outro duration (seconds) for a photo Outro; ignored for a video Outro.
    #[serde(default = "default_outro_dauer")]
    pub outro_dauer: f64,
    #[serde(default)]
    pub video_codec: VideoCodecPreference,
    #[serde(default = "default_crf")]
    pub crf: u8,
    /// Parallel body-clip prep / encode (legacy `parallel_processing_enabled`).
    #[serde(default = "default_true")]
    pub parallel_enabled: bool,
    /// Intro+Body mux: `"reencode"` (default) | `"stream_copy"`.
    #[serde(default = "default_intro_mux_mode")]
    pub intro_mux_mode: String,
    /// Multi-clip body concat: `"auto"` (default) | `"compatible"` | `"apple"` | `"fast"` | `"legacy"`.
    #[serde(default = "default_body_concat_mode")]
    pub body_concat_mode: String,
    /// Use NVENC/VideoToolbox when available (from config `hardware_acceleration_enabled`).
    #[serde(default)]
    pub hw_accel_enabled: bool,
    /// Speculative staging: finish body concat/copy at source codec; skip the forced
    /// target-codec re-encode so Erstellen can reuse the staged body and confirm then.
    #[serde(default)]
    pub defer_forced_reencode: bool,
}

fn default_intro_dauer() -> f64 {
    DEFAULT_INTRO_DAUER_SECS
}
fn default_outro_dauer() -> f64 {
    5.0
}
fn default_true() -> bool {
    true
}
fn default_crf() -> u8 {
    20
}
fn default_intro_mux_mode() -> String {
    "capcut".into()
}
fn default_body_concat_mode() -> String {
    "auto".into()
}

fn normalized_intro_mux_mode(mode: &str) -> String {
    crate::storage::config::normalize_intro_mux_mode(mode)
}

impl Default for CreateVideoOptions {
    fn default() -> Self {
        Self {
            dauer: DEFAULT_INTRO_DAUER_SECS,
            intro_enabled: true,
            outro_enabled: false,
            outro_path: String::new(),
            outro_dauer: default_outro_dauer(),
            video_codec: VideoCodecPreference::Auto,
            crf: 20,
            parallel_enabled: true,
            intro_mux_mode: default_intro_mux_mode(),
            body_concat_mode: default_body_concat_mode(),
            hw_accel_enabled: false,
            defer_forced_reencode: false,
        }
    }
}

/// Called when Intro+Body stream-copy cannot proceed.
/// Return `Err(())` to abort (cancellation).
pub type IntroMuxAskFn = Arc<dyn Fn(&str) -> Result<IntroMuxChoice, ()> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct CreateVideoResult {
    pub output: String,
    pub encoder: String,
    pub intro_created: bool,
    pub body_clips: usize,
}

/// Scaled usable content box inside the padded background region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentArea {
    pub x_start: i32,
    pub y_start: i32,
    pub usable_width: i32,
    pub usable_height: i32,
}

/// Encoding target matching a body clip (legacy `_get_video_info` subset).
#[derive(Debug, Clone)]
pub struct IntroVideoParams {
    pub width: u32,
    pub height: u32,
    pub fps: String,
    pub timescale: String,
    pub pix_fmt: String,
    pub vcodec: String,
    pub acodec: String,
    pub sample_rate: String,
    pub channel_layout: String,
    #[allow(dead_code)]
    pub has_b_frames: u32,
    #[allow(dead_code)]
    pub profile: Option<String>,
}

impl IntroVideoParams {
    #[allow(dead_code)]
    pub fn for_1080p30(vcodec: &str) -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: "30".into(),
            timescale: "30".into(),
            pix_fmt: "yuv420p".into(),
            vcodec: vcodec.to_string(),
            acodec: "aac".into(),
            sample_rate: "48000".into(),
            channel_layout: "stereo".into(),
            has_b_frames: 0,
            profile: Some("high".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Asset / path helpers
// ---------------------------------------------------------------------------

/// Resolve `resources/assets/<name>` (dev manifest dir or Tauri resource dir).
pub fn find_asset(name: &str, resource_dir: Option<&Path>) -> Result<PathBuf, ProcessorError> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = resource_dir {
        candidates.push(dir.join("assets").join(name));
        candidates.push(dir.join("resources").join("assets").join(name));
        candidates.push(dir.join(name));
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources").join("assets").join(name));

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("resources").join("assets").join(name));
            candidates.push(exe_dir.join("assets").join(name));
        }
    }

    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(ProcessorError::Message(format!(
        "asset not found: {name} (expected under resources/assets/)"
    )))
}

fn work_temp_dir(output: &str) -> Result<PathBuf, ProcessorError> {
    let parent = Path::new(output)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = parent.join(format!(".ats_work_{stamp}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn best_system_font() -> String {
    #[cfg(target_os = "windows")]
    {
        let segoe = [
            r"C:\Windows\Fonts\seguisb.ttf",
            r"C:\Windows\Fonts\segoeuib.ttf",
        ];
        for path in segoe {
            if Path::new(path).is_file() {
                return "Segoe UI Semibold".into();
            }
        }
        "Arial".into()
    }
    #[cfg(target_os = "macos")]
    {
        "Helvetica Neue".into()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "DejaVu Sans".into()
    }
}

/// Candidate TTF paths for Linux Intro `drawtext` (`fontfile=`).
///
/// Order: bundled asset → common distro DejaVu locations.
/// Pure path list — unit-tested; existence checked by [`resolve_linux_fontfile`].
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn linux_fontfile_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    paths.push(
        manifest
            .join("resources")
            .join("assets")
            .join("fonts")
            .join("DejaVuSans.ttf"),
    );
    paths.push(PathBuf::from(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ));
    paths.push(PathBuf::from(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ));
    paths.push(PathBuf::from("/usr/share/fonts/TTF/DejaVuSans.ttf"));
    paths.push(PathBuf::from("/usr/share/fonts/dejavu/DejaVuSans.ttf"));
    paths
}

/// First existing Linux TTF suitable for FFmpeg `fontfile=`.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn resolve_linux_fontfile() -> Option<PathBuf> {
    linux_fontfile_candidates()
        .into_iter()
        .find(|p| p.is_file())
}

/// Escape a filesystem path for use inside an FFmpeg filter option value.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn ffmpeg_escape_fontfile_path(path: &str) -> String {
    // Normalise separators then apply drawtext escaping (colon, quotes, commas).
    let normalised = path.replace('\\', "/");
    ffmpeg_escape_text(&normalised)
}

/// `font='…'` (Win/Mac) or `fontfile='…'` (Linux when a TTF is found).
fn drawtext_font_option() -> String {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(path) = resolve_linux_fontfile() {
            let escaped = ffmpeg_escape_fontfile_path(&path.to_string_lossy());
            return format!("fontfile='{escaped}'");
        }
    }
    let font_escaped = ffmpeg_escape_text(&best_system_font());
    format!("font='{font_escaped}'")
}

// ---------------------------------------------------------------------------
// Content area + drawtext (pure)
// ---------------------------------------------------------------------------

pub fn calculate_scaled_content_area(video_width: u32, video_height: u32) -> ContentArea {
    let bg_aspect = f64::from(HINTERGRUND_ORIGINAL_WIDTH) / f64::from(HINTERGRUND_ORIGINAL_HEIGHT);
    let video_aspect = f64::from(video_width) / f64::from(video_height.max(1));
    let vw = f64::from(video_width);
    let vh = f64::from(video_height);

    let (scaled_bg_width, scaled_bg_height, offset_x, offset_y) = if bg_aspect > video_aspect {
        let w = vw;
        let h = (vw / bg_aspect).floor();
        (w, h, 0.0, (vh - h) / 2.0)
    } else {
        let h = vh;
        let w = (vh * bg_aspect).floor();
        (w, h, (vw - w) / 2.0, 0.0)
    };

    let scale_x = scaled_bg_width / f64::from(HINTERGRUND_ORIGINAL_WIDTH);
    let scale_y = scaled_bg_height / f64::from(HINTERGRUND_ORIGINAL_HEIGHT);

    let content_x1 = CONTENT_AREA_X1 * scale_x + offset_x;
    let content_y1 = CONTENT_AREA_Y1 * scale_y + offset_y;
    let content_x2 = CONTENT_AREA_X2 * scale_x + offset_x;
    let content_y2 = CONTENT_AREA_Y2 * scale_y + offset_y;

    let content_width = content_x2 - content_x1;
    let content_height = content_y2 - content_y1;

    let pad_l = content_width * (CONTENT_AREA_PADDING_LEFT / 100.0);
    let pad_r = content_width * (CONTENT_AREA_PADDING_RIGHT / 100.0);
    let pad_t = content_height * (CONTENT_AREA_PADDING_TOP / 100.0);
    let pad_b = content_height * (CONTENT_AREA_PADDING_BOTTOM / 100.0);

    ContentArea {
        x_start: (content_x1 + pad_l) as i32,
        y_start: (content_y1 + pad_t) as i32,
        usable_width: (content_width - pad_l - pad_r) as i32,
        usable_height: (content_height - pad_t - pad_b) as i32,
    }
}

fn ffmpeg_escape_text(text: &str) -> String {
    text.replace('\\', r"\\")
        .replace(':', r"\:")
        .replace('\'', r"\''")
        .replace(',', r"\,")
}

fn estimate_text_width(text: &str, font_size: i32) -> i32 {
    (text.chars().count() as f64 * f64::from(font_size) * 0.6) as i32
}

fn wrap_text(text: &str, max_width: i32, font_size: i32) -> Vec<String> {
    let words: Vec<&str> = text.split(' ').collect();
    let mut lines = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for word in words {
        let mut test = current.clone();
        test.push(word);
        let joined = test.join(" ");
        if estimate_text_width(&joined, font_size) <= max_width {
            current.push(word);
        } else if current.is_empty() {
            lines.push(word.to_string());
        } else {
            lines.push(current.join(" "));
            current = vec![word];
        }
    }
    if !current.is_empty() {
        lines.push(current.join(" "));
    }
    if lines.is_empty() {
        lines.push(text.to_string());
    }
    lines
}

/// Build comma-joined `drawtext=…` filter chain for the intro overlay.
pub fn prepare_text_overlay(kunde: &Kunde, video_width: u32, video_height: u32) -> String {
    let area = calculate_scaled_content_area(video_width, video_height);
    let font_opt = drawtext_font_option();
    let gast = kunde.resolve_gast();

    let mut text_data: Vec<(&str, &str)> = vec![
        ("Gast:", gast.as_str()),
        ("Tandemmaster:", kunde.tandemmaster.as_str()),
    ];
    if kunde.is_outside_video() {
        text_data.push(("Videospringer:", kunde.videospringer.as_str()));
    }
    text_data.push(("Datum:", kunde.datum.as_str()));
    text_data.push(("Ort:", kunde.ort.as_str()));

    let font_size = (area.usable_height / 18).max(28);
    let line_height = (f64::from(font_size) * 2.5) as i32;
    let top_padding = (f64::from(area.usable_height) * 0.10) as i32;
    let mut current_y = area.y_start + top_padding;
    let value_x_start = area.x_start + (area.usable_width as f64 * 0.5) as i32;
    let max_value_width = (area.usable_width as f64 * 0.5) as i32;

    let mut cmds = Vec::new();

    for (label, value) in text_data {
        let wrapped = if estimate_text_width(value, font_size) > max_value_width {
            wrap_text(value, max_value_width, font_size)
        } else {
            vec![value.to_string()]
        };

        let label_escaped = ffmpeg_escape_text(label);
        cmds.push(format!(
            "drawtext=text='{label_escaped}':x={}:y={}:fontsize={font_size}:fontcolor=white:borderw=3:bordercolor=black:{font_opt}",
            area.x_start, current_y
        ));

        let mut value_y = current_y;
        for line in &wrapped {
            let value_escaped = ffmpeg_escape_text(line);
            cmds.push(format!(
                "drawtext=text='{value_escaped}':x={value_x_start}:y={value_y}:fontsize={font_size}:fontcolor=white:borderw=3:bordercolor=black:{font_opt}"
            ));
            value_y += line_height;
        }

        let lines_used = wrapped.len().max(1) as i32;
        current_y += line_height * lines_used;
    }

    cmds.join(",")
}

fn parse_fps_int(fps: &str) -> u32 {
    let s = fps.trim();
    if s.is_empty() {
        return 30;
    }
    if let Some((n, d)) = s.split_once('/') {
        let num: f64 = n.parse().unwrap_or(30.0);
        let den: f64 = d.parse().unwrap_or(1.0);
        return ((num / den.max(1e-9)).round() as u32).max(1);
    }
    s.parse::<f64>()
        .map(|v| v.round() as u32)
        .unwrap_or(30)
        .max(1)
}

fn parse_fps_f64(fps: &str) -> Option<f64> {
    let s = fps.trim();
    if s.is_empty() || s == "0/0" {
        return None;
    }
    if let Some((n, d)) = s.split_once('/') {
        let num: f64 = n.parse().ok()?;
        let den: f64 = d.parse().ok()?;
        if den.abs() < 1e-12 {
            return None;
        }
        return Some(num / den);
    }
    s.parse().ok()
}

/// True when two fps strings describe the same rate (exact, rounded-int, or ±0.05).
pub fn fps_rates_match(a: &str, b: &str) -> bool {
    if a.trim() == b.trim() {
        return true;
    }
    match (parse_fps_f64(a), parse_fps_f64(b)) {
        (Some(x), Some(y)) => (x - y).abs() < 0.05 || parse_fps_int(a) == parse_fps_int(b),
        _ => false,
    }
}

/// OPT-21A: probed source geometry used to skip redundant CapCut normalize filters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapcutSourceVideo {
    pub width: u32,
    pub height: u32,
    pub fps: String,
    pub pix_fmt: String,
}

impl CapcutSourceVideo {
    pub fn from_intro_params(p: &IntroVideoParams) -> Self {
        Self {
            width: p.width,
            height: p.height,
            fps: p.fps.clone(),
            pix_fmt: p.pix_fmt.clone(),
        }
    }
}

/// Which CapCut video-normalize filters are still required for one segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapcutNormalizePlan {
    pub scale_pad: bool,
    pub fps: bool,
    pub format: bool,
}

impl CapcutNormalizePlan {
    pub fn full() -> Self {
        Self {
            scale_pad: true,
            fps: true,
            format: true,
        }
    }

    pub fn none() -> Self {
        Self {
            scale_pad: false,
            fps: false,
            format: false,
        }
    }

    /// Any remaining CPU normalize filter (scale/pad/fps/format).
    pub fn needs_cpu_normalize(self) -> bool {
        self.scale_pad || self.fps || self.format
    }

    /// Safe to attach `-hwaccel` on this input (no CPU normalize left).
    pub fn allow_hwaccel_decode(self) -> bool {
        !self.needs_cpu_normalize()
    }
}

fn pix_fmt_matches_capcut_target(source: &str, target: &str) -> bool {
    let s = source.trim().to_ascii_lowercase();
    let t = target.trim().to_ascii_lowercase();
    if s.is_empty() || t.is_empty() {
        return false;
    }
    if s == t {
        return true;
    }
    // Full-range 4:2:0 is CapCut-equivalent to limited-range yuv420p.
    matches!(
        (s.as_str(), t.as_str()),
        ("yuvj420p", "yuv420p") | ("yuv420p", "yuvj420p")
    )
}

/// Decide which normalize filters a CapCut segment still needs.
///
/// `source = None` → conservative full graph (unknown geometry).
pub fn capcut_normalize_plan(
    source: Option<&CapcutSourceVideo>,
    target: &IntroVideoParams,
    target_pix_fmt: &str,
) -> CapcutNormalizePlan {
    let Some(src) = source else {
        return CapcutNormalizePlan::full();
    };
    CapcutNormalizePlan {
        scale_pad: src.width != target.width || src.height != target.height,
        fps: !fps_rates_match(&src.fps, &target.fps),
        format: !pix_fmt_matches_capcut_target(&src.pix_fmt, target_pix_fmt),
    }
}

/// NVENC/VideoToolbox decode accel name when normalize filters are fully skipped.
pub fn capcut_hwaccel_for_decode(hw: &HwAccelInfo, plan: CapcutNormalizePlan) -> Option<&str> {
    if !plan.allow_hwaccel_decode() || !hw.available {
        return None;
    }
    match hw.hw_type {
        HwType::Nvidia => Some("cuda"),
        HwType::Videotoolbox => Some("videotoolbox"),
        HwType::Software => None,
    }
}

/// Build `[idx:v]…[label]` CapCut video branch with conditional scale/pad/fps/format.
pub fn build_capcut_segment_vfilter(
    input_idx: usize,
    out_label: &str,
    plan: CapcutNormalizePlan,
    width: u32,
    height: u32,
    fps: &str,
    target_pix_fmt: &str,
    // Extra filters after normalize, before setpts (e.g. drawtext, trim).
    mid_filters: &[&str],
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if plan.scale_pad {
        parts.push(format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease"
        ));
        parts.push(format!(
            "pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black"
        ));
    }
    for f in mid_filters {
        if !f.is_empty() {
            parts.push((*f).to_string());
        }
    }
    if plan.fps {
        parts.push(format!("fps={fps}"));
    }
    if plan.format {
        parts.push(format!("format={target_pix_fmt}"));
    }
    parts.push("setpts=PTS-STARTPTS".into());
    parts.push("setsar=1".into());
    format!("[{input_idx}:v]{}[{out_label}]", parts.join(","))
}

fn push_media_input(args: &mut Vec<String>, path: &str, hwaccel: Option<&str>) {
    if let Some(accel) = hwaccel {
        args.push("-hwaccel".into());
        args.push(accel.to_string());
    }
    args.push("-i".into());
    args.push(path.to_string());
}

fn log_capcut_filter_plan(segment: &str, plan: CapcutNormalizePlan, hwaccel: Option<&str>) {
    logging::info(
        "encode",
        format!(
            "capcut.filters segment={segment} scale_pad={} fps={} format={} hwaccel={}",
            plan.scale_pad,
            plan.fps,
            plan.format,
            hwaccel.unwrap_or("none")
        ),
    );
}

// ---------------------------------------------------------------------------
// Intro FFmpeg command (pure)
// ---------------------------------------------------------------------------

/// Build FFmpeg args for intro from looping background + silent audio + drawtext.
pub fn build_intro_ffmpeg_args(
    hintergrund_path: &str,
    output_path: &str,
    dauer: f64,
    v_params: &IntroVideoParams,
    drawtext_filter: &str,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let video_filters = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
         {drawtext_filter},format={target_pix_fmt}",
        w = v_params.width,
        h = v_params.height,
    );

    let fps_int = parse_fps_int(&v_params.fps);
    let dauer = dauer.max(0.1);
    let force_t = (dauer - 0.05).max(0.0);

    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loop".into(),
        "1".into(),
        "-i".into(),
        hintergrund_path.to_string(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "anullsrc=channel_layout={}:sample_rate={}",
            v_params.channel_layout, v_params.sample_rate
        ),
        "-vf".into(),
        video_filters,
        "-c:v".into(),
        encoder.to_string(),
    ];
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
        "-c:a".into(),
        v_params.acodec.clone(),
        "-t".into(),
        format!("{dauer}"),
        "-shortest".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-force_key_frames".into(),
        format!("expr:eq(n,0)+gte(t,{force_t})"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);

    // Intro-specific quality overrides for software / NVENC (legacy).
    // quality_params already carry CRF/CQ; for intro prefer faster preset when libx264.
    // Callers should pass intro-tuned quality via `intro_quality_params`.

    args
}

/// Whether body audio can be stream-copied (AAC) after a video-only single-pass encode.
pub fn body_audio_is_aac_copyable(v_params: &IntroVideoParams) -> bool {
    matches!(
        v_params.acodec.to_ascii_lowercase().as_str(),
        "aac" | "mp4a"
    )
}

/// How audio is handled in [`build_intro_body_single_pass_args`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinglePassAudioMode {
    /// Filter-concat silence + body audio, then encode AAC.
    EncodeAac,
    /// Video only (`-an`) — caller muxes silent AAC + body audio via stream-copy.
    VideoOnly,
    /// No body audio: silent AAC for the full duration.
    EncodeSilence,
}

/// One continuous encode: intro overlay + full body → single MP4 bitstream.
///
/// Inputs: `0` = background still, `1` = body, `2` = silent AAC source (`anullsrc`).
///
/// OPT-21A: when `body_source` matches target WxH / fps / pix_fmt, body skips
/// scale/pad/fps/format. `body_hwaccel` (`cuda` / `videotoolbox`) is only safe when
/// those filters are fully skipped — callers must not pass it when CPU normalize remains.
pub fn build_intro_body_single_pass_args(
    hintergrund_path: &str,
    body_path: &str,
    output_path: &str,
    intro_dauer: f64,
    body_dauer: f64,
    v_params: &IntroVideoParams,
    drawtext_filter: &str,
    encoder: &str,
    quality_params: &[String],
    audio_mode: SinglePassAudioMode,
    body_source: Option<&CapcutSourceVideo>,
    body_hwaccel: Option<&str>,
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let intro_dauer = intro_dauer.max(0.1);
    let body_dauer = body_dauer.max(0.05);
    let total = intro_dauer + body_dauer;
    let fps_int = parse_fps_int(&v_params.fps);
    let w = v_params.width;
    let h = v_params.height;
    let fps = &v_params.fps;

    let body_plan = capcut_normalize_plan(body_source, v_params, &target_pix_fmt);
    // Never attach broken HW-decode when CPU normalize remains (ENOSYS risk).
    let body_hwaccel = if body_plan.allow_hwaccel_decode() {
        body_hwaccel
    } else {
        None
    };

    // Intro still always needs scale/pad/drawtext/format/fps (PNG → video).
    let intro_v = format!(
        "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
         {drawtext_filter},format={target_pix_fmt},fps={fps},\
         trim=duration={intro_dauer},setpts=PTS-STARTPTS,setsar=1[introv]"
    );
    let body_v = build_capcut_segment_vfilter(
        1,
        "bodyv",
        body_plan,
        w,
        h,
        fps,
        &target_pix_fmt,
        &[],
    );
    let v_concat = "[introv][bodyv]concat=n=2:v=1:a=0[v]";
    let aformat = format!(
        "aformat=sample_rates={}:channel_layouts={}",
        v_params.sample_rate, v_params.channel_layout
    );

    let filter_complex = match audio_mode {
        SinglePassAudioMode::EncodeAac => {
            format!(
                "{intro_v};{body_v};{v_concat};\
                 [2:a]atrim=0:{intro_dauer},asetpts=PTS-STARTPTS,{aformat}[introa];\
                 [1:a]asetpts=PTS-STARTPTS,{aformat}[bodya];\
                 [introa][bodya]concat=n=2:v=0:a=1[a]"
            )
        }
        SinglePassAudioMode::EncodeSilence => {
            format!(
                "{intro_v};{body_v};{v_concat};\
                 [2:a]atrim=0:{total},asetpts=PTS-STARTPTS[a]"
            )
        }
        SinglePassAudioMode::VideoOnly => {
            format!("{intro_v};{body_v};{v_concat}")
        }
    };

    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loop".into(),
        "1".into(),
        "-i".into(),
        hintergrund_path.to_string(),
    ];
    push_media_input(&mut args, body_path, body_hwaccel);
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "anullsrc=channel_layout={}:sample_rate={}",
            v_params.channel_layout, v_params.sample_rate
        ),
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        "[v]".into(),
    ]);

    match audio_mode {
        SinglePassAudioMode::VideoOnly => {
            args.push("-an".into());
        }
        SinglePassAudioMode::EncodeAac | SinglePassAudioMode::EncodeSilence => {
            args.extend(["-map".into(), "[a]".into()]);
        }
    }

    args.extend(["-c:v".into(), encoder.to_string()]);
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
    ]);

    match audio_mode {
        SinglePassAudioMode::VideoOnly => {}
        SinglePassAudioMode::EncodeAac | SinglePassAudioMode::EncodeSilence => {
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ]);
        }
    }

    args.extend([
        "-t".into(),
        format!("{total}"),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-force_key_frames".into(),
        format!("expr:eq(n,0)+gte(t,{intro_dauer})"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

// ---------------------------------------------------------------------------
// Phase 50 — Outro kinds + CapCut single-pass (Intro? + Body + Outro)
// ---------------------------------------------------------------------------

/// Whether the Outro asset is treated as a still photo or a video clip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutroKind {
    Photo,
    Video,
}

/// Common photo / video extensions used for the Outro (parity with app media filter).
const OUTRO_VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "m4v", "webm", "mts", "m2ts"];
const OUTRO_PHOTO_EXTS: &[&str] =
    &["jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp", "heic", "dng"];

/// Infer Outro media kind from the file extension (video wins ties; unknown → photo).
pub fn outro_media_kind(path: &str) -> OutroKind {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if OUTRO_VIDEO_EXTS.contains(&ext.as_str()) {
        OutroKind::Video
    } else if OUTRO_PHOTO_EXTS.contains(&ext.as_str()) {
        OutroKind::Photo
    } else {
        // Unknown extension → treat as photo (safe: loop still + silence).
        OutroKind::Photo
    }
}

/// Outro input for CapCut single-pass encode (`[Intro?] → Body → Outro`).
#[derive(Debug, Clone)]
pub struct SinglePassOutroInput {
    pub path: String,
    pub kind: OutroKind,
    /// Effective duration (photo: configured; video: probed).
    pub dauer: f64,
    /// True when a video Outro has an audio stream (photos are always silent).
    pub has_audio: bool,
}

/// One continuous CapCut-style encode: optional Intro PNG + Body + Outro (photo/video).
///
/// Same principle as [`build_intro_body_single_pass_args`]: body is encoded once; Intro/Outro
/// are filtergraph branches (no pre-rendered segment MP4s).
///
/// OPT-21A: `body_source` / `outro_source` skip redundant scale/pad/fps/format when matching.
/// `body_hwaccel` only applies when the body plan allows HW decode.
///
/// Input order:
/// 1. optional Intro still (`-loop 1`)
/// 2. Body
/// 3. Outro (still with `-loop 1`, or video)
/// 4. optional `anullsrc` when audio is encoded in-graph
pub fn build_intro_body_outro_single_pass_args(
    intro: Option<(&str, &str, f64)>,
    body_path: &str,
    body_dauer: f64,
    outro: &SinglePassOutroInput,
    output_path: &str,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
    audio_mode: SinglePassAudioMode,
    body_source: Option<&CapcutSourceVideo>,
    outro_source: Option<&CapcutSourceVideo>,
    body_hwaccel: Option<&str>,
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let body_dauer = body_dauer.max(0.05);
    let outro_dauer = outro.dauer.max(0.1);
    let intro_dauer = intro.map(|(_, _, d)| d.max(0.1)).unwrap_or(0.0);
    let total = intro_dauer + body_dauer + outro_dauer;
    let fps_int = parse_fps_int(&v_params.fps);
    let w = v_params.width;
    let h = v_params.height;
    let fps = &v_params.fps;
    let aformat = format!(
        "aformat=sample_rates={}:channel_layouts={}",
        v_params.sample_rate, v_params.channel_layout
    );

    let mut next_idx = 0usize;
    let intro_idx = if intro.is_some() {
        let i = next_idx;
        next_idx += 1;
        Some(i)
    } else {
        None
    };
    let body_idx = next_idx;
    next_idx += 1;
    let outro_idx = next_idx;
    next_idx += 1;
    let silence_idx = next_idx;

    let body_plan = capcut_normalize_plan(body_source, v_params, &target_pix_fmt);
    let body_hwaccel = if body_plan.allow_hwaccel_decode() {
        body_hwaccel
    } else {
        None
    };
    // Photo outro always normalizes; video outro may skip when source matches.
    let outro_plan = match outro.kind {
        OutroKind::Photo => CapcutNormalizePlan::full(),
        OutroKind::Video => capcut_normalize_plan(outro_source, v_params, &target_pix_fmt),
    };

    // Silence pads consumed from anullsrc (0 → no lavfi input).
    let silence_pads: usize = match audio_mode {
        SinglePassAudioMode::VideoOnly => 0,
        SinglePassAudioMode::EncodeSilence => 1,
        SinglePassAudioMode::EncodeAac => {
            usize::from(intro_idx.is_some()) + usize::from(!outro.has_audio)
        }
    };
    let need_silence_input = silence_pads > 0;

    let mut fc = String::new();
    let mut v_n = 0usize;

    if let (Some(ii), Some((_, drawtext, _))) = (intro_idx, intro) {
        fc.push_str(&format!(
            "[{ii}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
             {drawtext},format={target_pix_fmt},fps={fps},\
             trim=duration={intro_dauer},setpts=PTS-STARTPTS,setsar=1[introv];"
        ));
        v_n += 1;
    }
    fc.push_str(&build_capcut_segment_vfilter(
        body_idx,
        "bodyv",
        body_plan,
        w,
        h,
        fps,
        &target_pix_fmt,
        &[],
    ));
    fc.push(';');
    v_n += 1;
    match outro.kind {
        OutroKind::Photo => {
            fc.push_str(&format!(
                "[{outro_idx}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,format={target_pix_fmt},fps={fps},\
                 trim=duration={outro_dauer},setpts=PTS-STARTPTS,setsar=1[outrov];"
            ));
        }
        OutroKind::Video => {
            fc.push_str(&build_capcut_segment_vfilter(
                outro_idx,
                "outrov",
                outro_plan,
                w,
                h,
                fps,
                &target_pix_fmt,
                &[],
            ));
            fc.push(';');
        }
    }
    v_n += 1;

    if intro_idx.is_some() {
        fc.push_str("[introv]");
    }
    fc.push_str(&format!("[bodyv][outrov]concat=n={v_n}:v=1:a=0[v]"));

    match audio_mode {
        SinglePassAudioMode::VideoOnly => {}
        SinglePassAudioMode::EncodeSilence => {
            fc.push(';');
            if outro.has_audio {
                let lead = (intro_dauer + body_dauer).max(0.05);
                fc.push_str(&format!(
                    "[{silence_idx}:a]atrim=0:{lead},asetpts=PTS-STARTPTS,{aformat}[leada];\
                     [{outro_idx}:a]asetpts=PTS-STARTPTS,{aformat}[outroa];\
                     [leada][outroa]concat=n=2:v=0:a=1[a]"
                ));
            } else {
                fc.push_str(&format!(
                    "[{silence_idx}:a]atrim=0:{total},asetpts=PTS-STARTPTS[a]"
                ));
            }
        }
        SinglePassAudioMode::EncodeAac => {
            fc.push(';');
            if silence_pads >= 2 {
                fc.push_str(&format!("[{silence_idx}:a]asplit={silence_pads}"));
                for k in 0..silence_pads {
                    fc.push_str(&format!("[sil{k}]"));
                }
                fc.push(';');
            }
            let mut sil_k = 0usize;
            let mut a_n = 0usize;
            let mut a_concat = String::new();

            if intro_idx.is_some() {
                let src = if silence_pads >= 2 {
                    let s = format!("[sil{sil_k}]");
                    sil_k += 1;
                    s
                } else {
                    format!("[{silence_idx}:a]")
                };
                fc.push_str(&format!(
                    "{src}atrim=0:{intro_dauer},asetpts=PTS-STARTPTS,{aformat}[introa];"
                ));
                a_concat.push_str("[introa]");
                a_n += 1;
            }
            fc.push_str(&format!(
                "[{body_idx}:a]asetpts=PTS-STARTPTS,{aformat}[bodya];"
            ));
            a_concat.push_str("[bodya]");
            a_n += 1;
            if outro.has_audio {
                fc.push_str(&format!(
                    "[{outro_idx}:a]asetpts=PTS-STARTPTS,{aformat}[outroa];"
                ));
            } else {
                let src = if silence_pads >= 2 {
                    format!("[sil{sil_k}]")
                } else {
                    format!("[{silence_idx}:a]")
                };
                fc.push_str(&format!(
                    "{src}atrim=0:{outro_dauer},asetpts=PTS-STARTPTS,{aformat}[outroa];"
                ));
            }
            a_concat.push_str("[outroa]");
            a_n += 1;
            fc.push_str(&format!("{a_concat}concat=n={a_n}:v=0:a=1[a]"));
        }
    }

    let mut kf = String::from("eq(n,0)");
    let mut t_acc = 0.0_f64;
    if intro_dauer > 0.0 {
        t_acc += intro_dauer;
        kf.push_str(&format!("+gte(t,{t_acc})"));
    }
    t_acc += body_dauer;
    kf.push_str(&format!("+gte(t,{t_acc})"));

    let mut args = vec!["-y".into(), "-hide_banner".into()];
    if let Some((hintergrund, _, _)) = intro {
        args.extend([
            "-loop".into(),
            "1".into(),
            "-i".into(),
            hintergrund.to_string(),
        ]);
    }
    push_media_input(&mut args, body_path, body_hwaccel);
    match outro.kind {
        OutroKind::Photo => {
            args.extend([
                "-loop".into(),
                "1".into(),
                "-i".into(),
                outro.path.clone(),
            ]);
        }
        OutroKind::Video => {
            args.extend(["-i".into(), outro.path.clone()]);
        }
    }
    if need_silence_input {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "anullsrc=channel_layout={}:sample_rate={}",
                v_params.channel_layout, v_params.sample_rate
            ),
        ]);
    }

    args.extend(["-filter_complex".into(), fc, "-map".into(), "[v]".into()]);
    match audio_mode {
        SinglePassAudioMode::VideoOnly => args.push("-an".into()),
        SinglePassAudioMode::EncodeAac | SinglePassAudioMode::EncodeSilence => {
            args.extend(["-map".into(), "[a]".into()]);
        }
    }
    args.extend(["-c:v".into(), encoder.to_string()]);
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
    ]);
    match audio_mode {
        SinglePassAudioMode::VideoOnly => {}
        SinglePassAudioMode::EncodeAac | SinglePassAudioMode::EncodeSilence => {
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ]);
        }
    }
    args.extend([
        "-t".into(),
        format!("{total}"),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-force_key_frames".into(),
        format!("expr:{kf}"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

/// Build silent AAC args matching body sample rate / layout (for audio-copy mux).
pub fn build_silent_aac_args(
    output_path: &str,
    dauer: f64,
    sample_rate: &str,
    channel_layout: &str,
) -> Vec<String> {
    let dauer = dauer.max(0.1);
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("anullsrc=channel_layout={channel_layout}:sample_rate={sample_rate}"),
        "-t".into(),
        format!("{dauer}"),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-ac".into(),
        if channel_layout.contains("mono") {
            "1".into()
        } else {
            "2".into()
        },
        output_path.to_string(),
    ]
}

/// Extract body audio via stream-copy.
pub fn build_extract_audio_copy_args(input: &str, output_path: &str) -> Vec<String> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
        "-c:a".into(),
        "copy".into(),
        output_path.to_string(),
    ]
}

/// Mux video (no/ignored audio) + audio stream-copy → final MP4.
pub fn build_mux_video_audio_copy_args(
    video_path: &str,
    audio_path: &str,
    output_path: &str,
) -> Vec<String> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        video_path.to_string(),
        "-i".into(),
        audio_path.to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        output_path.to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Phase 50 — Outro segment builders (pure; kept for tests / optional fallback)
// ---------------------------------------------------------------------------

/// Build FFmpeg args for a photo Outro segment: looped still + silence, normalized to
/// the body params (scale/pad/fps/pixelformat). No drawtext (Outro stays un-personalized).
pub fn build_outro_photo_segment_args(
    image_path: &str,
    output_path: &str,
    dauer: f64,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let video_filters = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,format={target_pix_fmt}",
        w = v_params.width,
        h = v_params.height,
    );
    let fps_int = parse_fps_int(&v_params.fps);
    let dauer = dauer.max(0.1);

    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loop".into(),
        "1".into(),
        "-i".into(),
        image_path.to_string(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "anullsrc=channel_layout={}:sample_rate={}",
            v_params.channel_layout, v_params.sample_rate
        ),
        "-vf".into(),
        video_filters,
        "-c:v".into(),
        encoder.to_string(),
    ];
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-t".into(),
        format!("{dauer}"),
        "-shortest".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

/// Build FFmpeg args for a video Outro segment: normalize video (scale/pad/fps/pixfmt)
/// and keep its audio when present, otherwise lay down matching silence (`anullsrc`).
pub fn build_outro_video_segment_args(
    video_path: &str,
    output_path: &str,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
    has_audio: bool,
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let video_filters = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps},format={target_pix_fmt}",
        w = v_params.width,
        h = v_params.height,
        fps = v_params.fps,
    );
    let fps_int = parse_fps_int(&v_params.fps);

    let mut args = vec!["-y".into(), "-hide_banner".into(), "-i".into(), video_path.to_string()];
    if !has_audio {
        // Continuous audio track: silence spanning the (shorter) video via -shortest.
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "anullsrc=channel_layout={}:sample_rate={}",
                v_params.channel_layout, v_params.sample_rate
            ),
        ]);
    }
    args.extend(["-vf".into(), video_filters, "-c:v".into(), encoder.to_string()]);
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        v_params.sample_rate.clone(),
    ]);
    if has_audio {
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into()]);
    } else {
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
            "-shortest".into(),
        ]);
    }
    args.extend([
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

/// One normalized segment fed into the final continuous concat encode.
#[derive(Debug, Clone)]
pub struct ConcatSegment {
    pub path: String,
    pub has_audio: bool,
    pub duration: f64,
}

/// Build args for a single continuous re-encode that concatenates all `segments`
/// ([Intro?] → Body → [Outro?]) into one phone-safe bitstream (single SPS/PPS).
///
/// Video is normalized per segment (scale/pad/fps/format); audio is concatenated with
/// silence generated for any segment that has no audio track (continuous audio spur).
pub fn build_concat_segments_encode_args(
    segments: &[ConcatSegment],
    output_path: &str,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let target_pix_fmt = match v_params.pix_fmt.as_str() {
        "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.clone(),
        _ => "yuv420p".into(),
    };
    let w = v_params.width;
    let h = v_params.height;
    let fps = &v_params.fps;
    let fps_int = parse_fps_int(fps);
    let n = segments.len().max(1);
    let total = progress_encode_total_secs(
        &segments.iter().map(|s| s.duration).collect::<Vec<_>>(),
    );
    let silent_count = segments.iter().filter(|s| !s.has_audio).count();
    let aformat = format!(
        "aformat=sample_rates={}:channel_layouts={}",
        v_params.sample_rate, v_params.channel_layout
    );

    let mut args = vec!["-y".into(), "-hide_banner".into()];
    for seg in segments {
        args.push("-i".into());
        args.push(seg.path.clone());
    }
    let silence_idx = segments.len();
    if silent_count > 0 {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "anullsrc=channel_layout={}:sample_rate={}",
                v_params.channel_layout, v_params.sample_rate
            ),
        ]);
    }

    let mut fc = String::new();
    for i in 0..segments.len() {
        fc.push_str(&format!(
            "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps},format={target_pix_fmt},\
             setpts=PTS-STARTPTS,setsar=1[v{i}];"
        ));
    }
    if silent_count > 0 {
        fc.push_str(&format!("[{silence_idx}:a]asplit={silent_count}"));
        for k in 0..silent_count {
            fc.push_str(&format!("[sil{k}]"));
        }
        fc.push(';');
    }
    let mut sil_k = 0usize;
    for (i, seg) in segments.iter().enumerate() {
        if seg.has_audio {
            fc.push_str(&format!("[{i}:a]asetpts=PTS-STARTPTS,{aformat}[a{i}];"));
        } else {
            let dur = seg.duration.max(0.05);
            fc.push_str(&format!(
                "[sil{sil_k}]atrim=0:{dur},asetpts=PTS-STARTPTS,{aformat}[a{i}];"
            ));
            sil_k += 1;
        }
    }
    for i in 0..segments.len() {
        fc.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!("concat=n={n}:v=1:a=0[v];"));
    for i in 0..segments.len() {
        fc.push_str(&format!("[a{i}]"));
    }
    fc.push_str(&format!("concat=n={n}:v=0:a=1[a]"));

    args.extend([
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[v]".into(),
        "-map".into(),
        "[a]".into(),
        "-c:v".into(),
        encoder.to_string(),
    ]);
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        target_pix_fmt,
        "-r".into(),
        v_params.fps.clone(),
        "-video_track_timescale".into(),
        v_params.timescale.clone(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-t".into(),
        format!("{total}"),
        "-g".into(),
        fps_int.to_string(),
        "-keyint_min".into(),
        fps_int.to_string(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);
    args
}

/// Intro-tuned quality flags (faster preset / constqp) — without `-c:v`.
pub fn intro_quality_params(encoder: &str, crf: u8, use_hw: bool) -> Vec<String> {
    let enc = encoder.to_ascii_lowercase();
    if !use_hw {
        if enc == "libx265" {
            return vec![
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "20".into(),
            ];
        }
        return vec![
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            crf.max(1).min(51).to_string(),
        ];
    }
    if enc.ends_with("_nvenc") {
        return vec![
            "-rc".into(),
            "constqp".into(),
            "-qp".into(),
            "18".into(),
            "-preset".into(),
            "p2".into(),
            "-no-scenecut".into(),
            "1".into(),
        ];
    }
    if enc.ends_with("_videotoolbox") {
        return vec!["-q:v".into(), "50".into()];
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Probe helpers for intro params
// ---------------------------------------------------------------------------

pub fn intro_params_from_probe(stderr: &str, fallback_codec: &str) -> IntroVideoParams {
    let meta = probe::parse_video_metadata_from_probe(stderr);
    let (width, height, codec, fps_f) = match &meta {
        Some(m) => (m.width, m.height, m.codec.as_str(), m.fps),
        None => (1920, 1080, fallback_codec, 30.0),
    };

    let fps = if fps_f > 0.0 {
        if (fps_f - fps_f.round()).abs() < 0.01 {
            format!("{}", fps_f.round() as u32)
        } else {
            format!("{fps_f}")
        }
    } else {
        "30".into()
    };

    let pix_fmt = PIX_FMT_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        .unwrap_or_else(|| "yuv420p".into());

    let timescale = TBN_RE
        .captures(stderr)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .map(|t| {
            if let Some(stripped) = t.strip_suffix('k').or_else(|| t.strip_suffix('K')) {
                format!("{}", (stripped.parse::<f64>().unwrap_or(90.0) * 1000.0) as u64)
            } else {
                t
            }
        })
        .unwrap_or_else(|| parse_fps_int(&fps).to_string());

    let (acodec, sample_rate) = if let Some(caps) = AUDIO_STREAM_RE.captures(stderr) {
        (
            caps.get(1)
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_else(|| "aac".into()),
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "48000".into()),
        )
    } else {
        ("aac".into(), "48000".into())
    };

    IntroVideoParams {
        width,
        height,
        fps,
        timescale,
        pix_fmt,
        vcodec: if codec.is_empty() {
            fallback_codec.to_string()
        } else {
            codec.to_string()
        },
        acodec,
        sample_rate,
        channel_layout: "stereo".into(),
        has_b_frames: 0,
        profile: None,
    }
}

fn emit_stage(on_progress: &ProgressCallback, stage: f64, stages: f64, label: &str) {
    let pct_secs = (stage / stages) * 100.0;
    on_progress(progress_from_times(pct_secs, 100.0, label));
}

/// Start a pipeline sub-step: overall bar resets to 0–100 % for this operation (UI).
fn emit_step_start(on_progress: &ProgressCallback, label: &str) {
    on_progress(progress_from_times(0.0, 100.0, label));
}

/// Progress denominator for a long encode: sum of segment durations + 5 % headroom.
///
/// Avoids pinning the live bar near 100 % when container duration is slightly short
/// (common with Action-Cam / HEVC metadata). Combined with the 99 % live-tick cap in
/// [`progress_from_times_with_task`].
fn progress_encode_total_secs(parts: &[f64]) -> f64 {
    let sum: f64 = parts.iter().copied().map(|s| s.max(0.0)).sum();
    (sum * 1.05).max(0.1)
}

fn push_ffmpeg_progress_args(args: &mut Vec<String>) {
    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ]);
}

/// Map nested FFmpeg 0–100 % into `[lo, hi]` on the overall bar (single step only).
fn map_substep_progress_label(
    outer: ProgressCallback,
    lo: f64,
    hi: f64,
    label: &'static str,
) -> ProgressCallback {
    let span = (hi - lo).max(0.0);
    Arc::new(move |p: crate::video::progress::EncodeProgress| {
        let mut q = p;
        q.percent = lo + (q.percent.clamp(0.0, 100.0) / 100.0) * span;
        if q.status == "continue" || q.status == "end" || q.status.is_empty() {
            q.status = label.into();
        }
        outer(q);
    })
}

fn map_substep_progress(outer: ProgressCallback, lo: f64, hi: f64) -> ProgressCallback {
    map_substep_progress_label(outer, lo, hi, "Audio anhängen (Copy)…")
}

/// Body Fast/Compatible/Legacy concat may emit per-clip prep `task_id`s (Legacy
/// MPEG-TS). Keep overall status only so the floating progress panel does not grow.
/// Compatible prep (Phase 43.1) emits aggregate overall events without `task_id`.
/// Parallel mixed-codec re-encode still uses the raw `on_progress` (clip bars wanted).
fn body_concat_overall_progress(on_progress: ProgressCallback) -> ProgressCallback {
    Arc::new(move |p: crate::video::progress::EncodeProgress| {
        if p.task_id.is_some() {
            return;
        }
        on_progress(p);
    })
}

/// Build FFmpeg args for a single body-clip encode (match resolution/fps of `v_params`).
pub fn build_body_clip_encode_args(
    input: &str,
    output: &str,
    v_params: &IntroVideoParams,
    encoder: &str,
    quality_params: &[String],
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        input.to_string(),
        "-vf".into(),
        format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps}",
            w = v_params.width,
            h = v_params.height,
            fps = v_params.fps,
        ),
        "-c:v".into(),
        encoder.to_string(),
    ];
    args.extend(quality_params.iter().cloned());
    args.extend([
        "-pix_fmt".into(),
        v_params.pix_fmt.clone(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        v_params.sample_rate.clone(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Encode multiple body clips in parallel (legacy per_clip + ParallelVideoProcessor).
pub fn encode_body_clips_parallel(
    ffmpeg: &Path,
    inputs: &[String],
    outputs: &[String],
    v_params: &IntroVideoParams,
    hw: &HwAccelInfo,
    crf: u8,
    hw_accel_enabled: bool,
    on_progress: ProgressCallback,
) -> Result<(), ProcessorError> {
    if inputs.len() != outputs.len() {
        return Err(ProcessorError::Message(
            "encode_body_clips_parallel: inputs/outputs length mismatch".into(),
        ));
    }
    if inputs.is_empty() {
        return Ok(());
    }

    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };
    let (encoder, quality) = build_encode_output_params(hw, codec, crf, !hw_accel_enabled);
    // quality includes -c:v; strip for build_body_clip_encode_args which adds encoder itself
    let quality_only: Vec<String> = {
        let mut q = quality;
        if q.first().map(|s| s.as_str()) == Some("-c:v") && q.len() >= 2 {
            q.drain(0..2);
        }
        q
    };

    let pool = ParallelVideoProcessor::new(hw_accel_enabled && hw.available);
    let ffmpeg_path = ffmpeg.to_path_buf();
    let inputs_owned = inputs.to_vec();
    let outputs_owned = outputs.to_vec();
    let v_params = v_params.clone();
    let progress = Arc::clone(&on_progress);

    let results = pool.process_indexed(
        inputs_owned.len(),
        |i, task_id| -> Result<(), ProcessorError> {
            if is_cancelled() {
                return Err(ProcessorError::Ffmpeg(FfmpegError::Cancelled));
            }
            let clip_name = Path::new(&inputs_owned[i])
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("Clip {}", i + 1));
            let activity = format!(
                "Clip {task_id}/{total}: {clip_name} — kodieren",
                total = inputs_owned.len()
            );
            let done = format!(
                "Clip {task_id}/{total}: {clip_name} — fertig",
                total = inputs_owned.len()
            );
            let task_progress = {
                let outer = Arc::clone(&progress);
                let activity = activity.clone();
                let done = done.clone();
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
                    if q.status == "end" {
                        q.status = done.clone();
                    } else if q.status == "continue" || q.status.is_empty() {
                        q.status = activity.clone();
                    }
                    outer(q);
                })
            };
            let dur = probe_duration_secs(&ffmpeg_path, &inputs_owned[i]).unwrap_or(0.0);
            progress(progress_from_times_with_task(
                0.0,
                100.0,
                &activity,
                Some(task_id),
            ));
            let args = build_body_clip_encode_args(
                &inputs_owned[i],
                &outputs_owned[i],
                &v_params,
                &encoder,
                &quality_only,
            );
            run_ffmpeg_tagged(
                &ffmpeg_path,
                &args,
                dur,
                Some(task_id),
                task_progress,
            )?;
            progress(progress_from_times_with_task(
                100.0,
                100.0,
                &done,
                Some(task_id),
            ));
            Ok(())
        },
        None,
    )?;

    for r in results {
        r?;
    }
    Ok(())
}

fn body_codecs_compatible(ffmpeg: &Path, paths: &[String]) -> bool {
    if paths.len() < 2 {
        return true;
    }
    let codecs = probe_body_codecs(ffmpeg, paths);
    if codecs.iter().any(|c| matches!(c, VideoCodec::Other)) || codecs.len() != paths.len() {
        return false;
    }
    let first = codecs[0];
    codecs.iter().all(|c| *c == first)
}

/// Probe each path's video codec (best-effort; missing → skipped).
/// Prefers OPT-16 process-local probe cache when warm.
fn probe_body_codecs(ffmpeg: &Path, paths: &[String]) -> Vec<VideoCodec> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        if let Some(cached) = super::probe_cache::get(p) {
            out.push(concat::normalize_vcodec_name(&cached.codec));
            continue;
        }
        let Ok(stderr) = ffmpeg_probe_stderr(ffmpeg, p) else {
            continue;
        };
        let _ = super::probe_cache::put_from_stderr(p, &stderr);
        let meta = probe::parse_video_metadata_from_probe(&stderr);
        let codec = meta
            .as_ref()
            .map(|m| concat::normalize_vcodec_name(&m.codec))
            .unwrap_or(VideoCodec::Other);
        out.push(codec);
    }
    out
}

/// True when an explicit codec preference (≠ Auto) requires re-encoding the produced
/// body: its actual codec differs from the resolved target. `Auto` never forces this
/// (stream-copy keeps the source codec).
pub(crate) fn body_needs_forced_reencode(pref: VideoCodecPreference, body_codec: &str) -> bool {
    if matches!(pref, VideoCodecPreference::Auto) {
        return false;
    }
    concat::normalize_vcodec_name(body_codec) != resolve_output_codec(pref, body_codec)
}

/// Target codec for mixed-body re-encode: forced preference, else majority (tie → H.264).
fn resolve_mixed_body_target_pref(
    pref: VideoCodecPreference,
    ffmpeg: &Path,
    paths: &[String],
) -> String {
    match pref {
        VideoCodecPreference::H264 => "h264".into(),
        VideoCodecPreference::H265 => "h265".into(),
        VideoCodecPreference::Auto => {
            let codecs = probe_body_codecs(ffmpeg, paths);
            video_codec_to_pref_str(majority_body_codec(&codecs)).into()
        }
    }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Create final MP4: optional intro + body clips → `output`.
///
/// Default mux: encode intro clip, stream-copy join with body (fast).
/// `intro_mux_mode = capcut` (product default): one continuous H.264 export (CapCut-style).
/// Other mode names are normalized to `capcut` on config load/save.
pub fn create_video(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    output: &str,
    options: &CreateVideoOptions,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
    on_intro_mux_fallback: Option<IntroMuxAskFn>,
    on_body_concat_fallback: Option<BodyConcatAskFn>,
    on_reencode: Option<ReencodeAskFn>,
) -> Result<CreateVideoResult, ProcessorError> {
    if video_paths.is_empty() {
        return Err(ProcessorError::Message(
            "at least one video path is required".into(),
        ));
    }
    if output.trim().is_empty() {
        return Err(ProcessorError::Message("output path is required".into()));
    }
    for p in video_paths {
        if !Path::new(p).is_file() {
            return Err(ProcessorError::Message(format!("video not found: {p}")));
        }
    }

    // Phase 50: fail fast when Outro is on but the asset is missing (block Preview/Erstellen
    // with a clear message instead of a late encode failure).
    let outro_active = options.outro_enabled && !options.outro_path.trim().is_empty();
    if options.outro_enabled {
        let outro_p = options.outro_path.trim();
        if outro_p.is_empty() {
            return Err(ProcessorError::Message(
                "Outro ist aktiviert, aber kein Medium hinterlegt.".into(),
            ));
        }
        if !Path::new(outro_p).is_file() {
            return Err(ProcessorError::Message(format!(
                "Outro-Datei nicht gefunden: {outro_p}"
            )));
        }
    }

    let stages = 3.0;
    let work = work_temp_dir(output)?;
    let mut encoder_used = String::from("libx264");
    let hw = detect_hardware();
    let hw_accel_enabled = options.hw_accel_enabled;
    // Explicit codec choice (≠ Auto): the exported video must be this codec.
    // Route the body through a temp file so `export_body_to_output` can re-encode
    // when the produced body codec differs from the forced target.
    // Speculative staging may defer that re-encode — then write the source-codec
    // body straight to `output` (no temp hop) for later commit-time encode.
    let force_codec = !matches!(options.video_codec, VideoCodecPreference::Auto)
        && !options.defer_forced_reencode;

    // Stage 1: body (single path, parallel per-clip encode, or concat)
    if options.intro_enabled {
        emit_step_start(&on_progress, "Bereite Videoclips vor…");
    } else {
        emit_stage(&on_progress, 0.0, stages, "Bereite Videoclips vor…");
    }
    // Without intro (and without a forced codec), write the body concat straight to
    // the final output to skip an extra remux pass in `export_body_to_output`.
    let body_target = if options.intro_enabled || force_codec || outro_active {
        work.join("body_concat.mp4").to_string_lossy().to_string()
    } else {
        output.to_string()
    };
    let body_path = if video_paths.len() == 1 {
        video_paths[0].clone()
    } else if options.parallel_enabled && !body_codecs_compatible(ffmpeg, video_paths) {
        // Mixed codecs → per_clip encode in parallel, then stream-copy concat.
        // Resolve target before confirm so the dialog can show `auto (H.264|H.265)`.
        let target_pref =
            resolve_mixed_body_target_pref(options.video_codec, ffmpeg, video_paths);
        let intent = ReencodeIntent::new(
            ReencodeKind::BodyParallel,
            "Unterschiedliche Codecs unter den Clips — parallele Neu-Kodierung",
        )
        .with_params(ReencodeParams {
            crf: Some(options.crf),
            hw_accel: Some(hw_accel_enabled),
            clip_count: Some(video_paths.len()),
            strategy: Some("per_clip_parallel".into()),
            target_codec: Some(target_pref.clone()),
            ..Default::default()
        });
        on_progress(progress_from_times(
            2.0,
            100.0,
            "Neu-Kodierung — warte auf Bestätigung…",
        ));
        let profile = reencode_confirm::require_confirm(on_reencode.as_ref(), &intent)
            .map_err(|_| ProcessorError::Ffmpeg(FfmpegError::Cancelled))?;
        let encode_crf = profile.crf;
        let encode_hw = profile.hw_accel;
        let pool = ParallelVideoProcessor::new(encode_hw && hw.available);
        on_progress(progress_from_times_with_task(
            0.0,
            100.0,
            &format!(
                "Kodiere {} Clips parallel ({} Worker): unterschiedliche Codecs unter den Clips",
                video_paths.len(),
                pool.max_workers,
            ),
            None,
        ));

        let probe0 = ffmpeg_probe_stderr(ffmpeg, &video_paths[0])?;
        let body_codec_name = profile
            .resolved_codec
            .clone()
            .filter(|c| c == "h264" || c == "h265")
            .or_else(|| Some(target_pref.clone()))
            .unwrap_or_else(|| {
                probe::parse_video_metadata_from_probe(&probe0)
                    .map(|m| m.codec)
                    .unwrap_or_else(|| "h264".into())
            });
        let codec_pref = profile.codec_preference();
        let out_codec = resolve_output_codec(codec_pref, &body_codec_name);
        let mut v_params = intro_params_from_probe(&probe0, &body_codec_name);
        v_params.vcodec = match out_codec {
            VideoCodec::Hevc => "hevc".into(),
            _ => "h264".into(),
        };

        let mut clip_outs = Vec::with_capacity(video_paths.len());
        for i in 0..video_paths.len() {
            clip_outs.push(
                work.join(format!("body_clip_{i}.mp4"))
                    .to_string_lossy()
                    .to_string(),
            );
        }
        encode_body_clips_parallel(
            ffmpeg,
            video_paths,
            &clip_outs,
            &v_params,
            &hw,
            encode_crf,
            encode_hw,
            Arc::clone(&on_progress),
        )?;

        let cb = body_concat_overall_progress(Arc::clone(&on_progress));
        emit_step_start(&on_progress, "Füge kodierte Clips zusammen…");
        concat::concat_videos_with_opts(
            ffmpeg,
            &clip_outs,
            &body_target,
            cb,
            encode_hw,
            encode_crf,
            &options.body_concat_mode,
            on_body_concat_fallback.as_ref(),
            on_reencode.as_ref(),
        )?;
        encoder_used = v_params.vcodec.clone();
        body_target
    } else {
        // Neutral overall status — worker count is misleading for Fast/Compatible.
        if video_paths.len() > 1 {
            emit_step_start(&on_progress, "Füge Clips zusammen…");
        }
        let cb = body_concat_overall_progress(Arc::clone(&on_progress));
        concat::concat_videos_with_opts(
            ffmpeg,
            video_paths,
            &body_target,
            cb,
            hw_accel_enabled,
            options.crf,
            &options.body_concat_mode,
            on_body_concat_fallback.as_ref(),
            on_reencode.as_ref(),
        )?;
        body_target
    };
    if options.intro_enabled {
        // When Outro follows, do not pin the bar at 100% — CapCut mux is still ahead.
        let body_done_pct = if outro_active { 5.0 } else { 100.0 };
        on_progress(progress_from_times(
            body_done_pct,
            100.0,
            "Videoclips vorbereitet",
        ));
    } else if outro_active {
        on_progress(progress_from_times(
            5.0,
            100.0,
            "Videoclips vorbereitet",
        ));
    } else {
        emit_stage(&on_progress, 1.0, stages, "Videoclips vorbereitet");
    }

    let body_stderr = ffmpeg_probe_stderr(ffmpeg, &body_path)?;
    let body_meta = probe::parse_video_metadata_from_probe(&body_stderr);
    let body_codec_name = body_meta
        .as_ref()
        .map(|m| m.codec.as_str())
        .unwrap_or("h264");
    let out_codec = resolve_output_codec(options.video_codec, body_codec_name);
    // Explicit codec (≠ Auto) whose target differs from the produced body → re-encode
    // on export instead of stream-copy, so the output is really the requested codec.
    // Speculative staging defers this step so Erstellen can reuse the concat body.
    let force_reencode = body_needs_forced_reencode(options.video_codec, body_codec_name)
        && !options.defer_forced_reencode;
    let mut v_params = intro_params_from_probe(&body_stderr, body_codec_name);
    v_params.vcodec = match out_codec {
        VideoCodec::Hevc => "hevc".into(),
        _ => "h264".into(),
    };

    let final_body = if outro_active {
        // Phase 50: [Intro?] → Body → Outro in one continuous, phone-safe encode
        // (CapCut principle). Codec: explicit H.265 → HEVC; Auto / H.264 → H.264.
        let outro_path = options.outro_path.trim().to_string();
        let outro_kind = outro_media_kind(&outro_path);
        let capcut_codec = match options.video_codec {
            VideoCodecPreference::H265 => VideoCodec::Hevc,
            _ => VideoCodec::H264,
        };
        let capcut_codec_str = match capcut_codec {
            VideoCodec::Hevc => "h265",
            _ => "h264",
        };
        let mut capcut_params = v_params.clone();
        capcut_params.vcodec = match capcut_codec {
            VideoCodec::Hevc => "hevc".into(),
            _ => "h264".into(),
        };
        // OPT-21A: source geometry before forcing phone-safe pix_fmt.
        let body_source = CapcutSourceVideo::from_intro_params(&v_params);
        capcut_params.pix_fmt = "yuv420p".into(); // 8-bit 4:2:0 — iOS-safe
        let profile =
            EncodeProfile::capcut_export(hw_accel_enabled, options.crf, capcut_codec_str);

        // Intro strings must outlive the mux call; declared here, filled when enabled.
        let hintergrund_s: String;
        let drawtext: String;
        let intro_opt = if options.intro_enabled {
            let hintergrund = find_asset(ASSET_HINTERGRUND, resource_dir)?;
            hintergrund_s = hintergrund.to_string_lossy().to_string();
            drawtext = prepare_text_overlay(kunde, capcut_params.width, capcut_params.height);
            Some((hintergrund_s.as_str(), drawtext.as_str(), options.dauer))
        } else {
            None
        };

        let outcome = mux_with_outro(
            ffmpeg,
            intro_opt,
            &body_path,
            &outro_path,
            outro_kind,
            options.outro_dauer,
            output,
            &capcut_params,
            &hw,
            &profile,
            Some(&body_source),
            &work,
            Arc::clone(&on_progress),
        )?;
        encoder_used = outcome.codec;
        on_progress(progress_from_times(100.0, 100.0, "Zusammenfügen fertig"));

        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created: options.intro_enabled,
            body_clips: video_paths.len(),
        }
    } else if options.intro_enabled {
        let hintergrund = find_asset(ASSET_HINTERGRUND, resource_dir)?;
        let hintergrund_s = hintergrund.to_string_lossy().to_string();
        let drawtext = prepare_text_overlay(kunde, v_params.width, v_params.height);
        let intro_path = work.join("intro.mp4");
        let intro_s = intro_path.to_string_lossy().to_string();
        let intro_mux = normalized_intro_mux_mode(&options.intro_mux_mode);
        let force_single_pass = intro_mux == "single_pass";
        let capcut_export = intro_mux == "capcut";

        let mux_cb: ProgressCallback = {
            let outer = Arc::clone(&on_progress);
            Arc::new(move |p: crate::video::progress::EncodeProgress| {
                // Intro+Body mux reuses the multi-clip concat prep path (2 segments).
                // Do not surface those as "Clip 1/2" task bars — overall stage only.
                if p.task_id.is_some() {
                    return;
                }
                let mut q = p;
                // Keep FFmpeg `continue`/`end` transient so the UI retains the last
                // concrete status — especially re-encode reasons.
                if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                    q.status = "continue".into();
                } else if q.status == "probing" {
                    q.status = "Analysiere Intro/Video…".into();
                } else if q.status == "mpegts-concat"
                    || q.status == "prepare"
                    || q.status == "prepare-done"
                {
                    q.status = "Füge Intro und Video zusammen…".into();
                } else if let Some(reason) = q.status.strip_prefix("Kodiere neu: ") {
                    q.status = format!("Kodiere Intro+Video neu: {reason}");
                } else if q.status == "re-encode" {
                    q.status = "Kodiere Intro+Video neu: Intro und Body nicht stream-copy-kompatibel"
                        .into();
                } else if q.status == "hevc-mkv-fallback" {
                    q.status = "Kodiere Intro+Video: HEVC Stream-Copy-Fallback (MKV-Remux)…".into();
                }
                outer(q);
            })
        };

        let handle_needs_reencode =
            |reason: String| -> Result<concat::ConcatOutcome, ConcatError> {
                let choice = if let Some(ask) = &on_intro_mux_fallback {
                    on_progress(progress_from_times(
                        0.0,
                        100.0,
                        "Stream-Copy Intro+Video fehlgeschlagen — warte auf Entscheidung…",
                    ));
                    match ask(&reason) {
                        Ok(c) => c,
                        Err(()) => {
                            return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
                        }
                    }
                } else {
                    // Preview / silent path: keep previous auto re-encode behaviour
                    // (still gated by on_reencode below).
                    IntroMuxChoice::WithIntroEncode
                };

                match choice {
                    IntroMuxChoice::WithoutIntro => {
                        emit_step_start(
                            &on_progress,
                            "Exportiere Video ohne Intro (Stream-Copy)…",
                        );
                        let enc = export_body_to_output(
                            ffmpeg,
                            &body_path,
                            output,
                            &hw,
                            out_codec,
                            options.crf,
                            hw_accel_enabled,
                            force_reencode,
                            Arc::clone(&on_progress),
                            on_reencode.as_ref(),
                        )
                        .map_err(|e| match e {
                            ProcessorError::Ffmpeg(fe) => ConcatError::Ffmpeg(fe),
                            ProcessorError::Concat(ce) => ce,
                            other => ConcatError::Message(other.to_string()),
                        })?;
                        Ok(concat::ConcatOutcome {
                            method: "body-only".into(),
                            codec: enc,
                            reencode_reason: Some(reason),
                        })
                    }
                    IntroMuxChoice::WithIntroEncode => {
                        // User already chose re-encode via IntroMux dialog when ask was set.
                        // When ask was None (preview), require explicit re-encode confirm.
                        let (encode_crf, encode_hw) = if on_intro_mux_fallback.is_none() {
                            let intent = ReencodeIntent::new(
                                ReencodeKind::IntroMux,
                                reason.clone(),
                            )
                            .with_params(ReencodeParams {
                                crf: Some(options.crf),
                                hw_accel: Some(hw_accel_enabled),
                                clip_count: Some(video_paths.len()),
                                intro_duration_secs: Some(options.dauer),
                                intro_mux_mode: Some(options.intro_mux_mode.clone()),
                                strategy: Some("single_pass_intro_body".into()),
                                target_codec: Some(v_params.vcodec.clone()),
                                ..Default::default()
                            });
                            on_progress(progress_from_times(
                                0.0,
                                100.0,
                                "Neu-Kodierung — warte auf Bestätigung…",
                            ));
                            let profile = reencode_confirm::require_confirm(
                                on_reencode.as_ref(),
                                &intent,
                            )
                            .map_err(|_| ConcatError::Ffmpeg(FfmpegError::Cancelled))?;
                            (profile.crf, profile.hw_accel)
                        } else {
                            (options.crf, hw_accel_enabled)
                        };
                        mux_intro_body_single_pass(
                            ffmpeg,
                            &hintergrund_s,
                            &body_path,
                            output,
                            options.dauer,
                            &v_params,
                            &drawtext,
                            &hw,
                            encode_crf,
                            encode_hw,
                            None,
                            None,
                            &work,
                            Arc::clone(&mux_cb),
                        )
                    }
                }
            };

        let mux_result = if capcut_export {
            // CapCut-style: one continuous encode → a single bitstream with one SPS/PPS.
            // That is what makes it play on iPhone/QuickTime (stream-copy splice leaves two
            // parameter sets → phones show audio only). Fast preset keeps it quick.
            //
            // Codec: explicit H.265 → HEVC (hvc1); Auto / explicit H.264 → H.264 (universal).
            let capcut_codec = match options.video_codec {
                VideoCodecPreference::H265 => VideoCodec::Hevc,
                _ => VideoCodec::H264,
            };
            let capcut_codec_str = match capcut_codec {
                VideoCodec::Hevc => "h265",
                _ => "h264",
            };
            let mut capcut_params = v_params.clone();
            capcut_params.vcodec = match capcut_codec {
                VideoCodec::Hevc => "hevc".into(),
                _ => "h264".into(),
            };
            let body_source = CapcutSourceVideo::from_intro_params(&v_params);
            capcut_params.pix_fmt = "yuv420p".into(); // 8-bit 4:2:0 — iOS-safe (H.264 & HEVC Main)
            let profile =
                EncodeProfile::capcut_export(hw_accel_enabled, options.crf, capcut_codec_str);
            mux_intro_body_single_pass(
                ffmpeg,
                &hintergrund_s,
                &body_path,
                output,
                options.dauer,
                &capcut_params,
                &drawtext,
                &hw,
                profile.crf,
                profile.hw_accel,
                Some(&profile),
                Some(&body_source),
                &work,
                Arc::clone(&mux_cb),
            )
        } else if force_single_pass {
            // Max splice safety: one continuous encode + optional confirm dialog.
            let intent = ReencodeIntent::new(
                ReencodeKind::IntroMux,
                "Intro+Body durchgängig kodieren (max. Schnitt-Kompatibilität)",
            )
            .with_params(ReencodeParams {
                crf: Some(options.crf),
                hw_accel: Some(hw_accel_enabled),
                clip_count: Some(video_paths.len()),
                intro_duration_secs: Some(options.dauer),
                intro_mux_mode: Some(options.intro_mux_mode.clone()),
                strategy: Some("single_pass_intro_body".into()),
                target_codec: Some(v_params.vcodec.clone()),
                ..Default::default()
            });
            on_progress(progress_from_times(
                0.0,
                100.0,
                "Neu-Kodierung — warte auf Bestätigung…",
            ));
            let profile = reencode_confirm::require_confirm(on_reencode.as_ref(), &intent)
                .map_err(|_| ProcessorError::Ffmpeg(FfmpegError::Cancelled))?;
            mux_intro_body_single_pass(
                ffmpeg,
                &hintergrund_s,
                &body_path,
                output,
                options.dauer,
                &v_params,
                &drawtext,
                &hw,
                profile.crf,
                profile.hw_accel,
                None,
                None,
                &work,
                Arc::clone(&mux_cb),
            )
        } else {
            // Fast join: encode intro only, stream-copy join; fallback on failure.
            emit_step_start(&on_progress, "Erstelle Intro…");
            let intro_cb = {
                let outer = Arc::clone(&on_progress);
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
                    q.task_id = None;
                    if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                        q.status = "Erstelle Intro…".into();
                    }
                    outer(q);
                })
            };
            create_intro_clip(
                ffmpeg,
                &hintergrund_s,
                &intro_s,
                options.dauer,
                &v_params,
                &drawtext,
                &hw,
                options.crf,
                hw_accel_enabled,
                intro_cb,
            )?;
            on_progress(progress_from_times(100.0, 100.0, "Intro fertig"));

            emit_step_start(&on_progress, "Füge Intro und Video zusammen…");
            let paths = vec![intro_s.clone(), body_path.clone()];
            match concat::concat_intro_with_body(
                ffmpeg,
                &paths,
                output,
                Arc::clone(&mux_cb),
            ) {
                Ok(outcome) => Ok(outcome),
                Err(ConcatError::NeedsReencode { reason }) => handle_needs_reencode(reason),
                Err(e) => Err(e),
            }
        };

        let outcome = mux_result?;
        let intro_created = outcome.method != "body-only";
        encoder_used = outcome.codec;
        on_progress(progress_from_times(100.0, 100.0, "Zusammenfügen fertig"));

        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created,
            body_clips: video_paths.len(),
        }
    } else {
        // No intro: copy/re-mux body to output — or re-encode when a forced codec
        // (≠ Auto) differs from the produced body codec (source → target mismatch).
        emit_stage(&on_progress, 1.0, stages, "Exportiere Video…");
        if Path::new(&body_path) != Path::new(output) {
            encoder_used = export_body_to_output(
                ffmpeg,
                &body_path,
                output,
                &hw,
                out_codec,
                options.crf,
                hw_accel_enabled,
                force_reencode,
                Arc::clone(&on_progress),
                on_reencode.as_ref(),
            )?;
        }
        emit_stage(&on_progress, 2.0, stages, "Export fertig");
        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created: false,
            body_clips: video_paths.len(),
        }
    };

    // Best-effort cleanup
    let _ = fs::remove_dir_all(&work);

    on_progress(progress_from_times(100.0, 100.0, "Video fertig"));
    Ok(final_body)
}

/// Export body to `output`.
///
/// Default: stream-copy remux (fast); re-encode only if the remux fails.
/// When `force_reencode` is set (explicit codec ≠ Auto and body codec differs
/// from the forced target), skip the copy attempt and re-encode to `out_codec`.
pub(crate) fn export_body_to_output(
    ffmpeg: &Path,
    body_path: &str,
    output: &str,
    hw: &HwAccelInfo,
    out_codec: VideoCodec,
    crf: u8,
    hw_accel_enabled: bool,
    force_reencode: bool,
    on_progress: ProgressCallback,
    on_reencode: Option<&ReencodeAskFn>,
) -> Result<String, ProcessorError> {
    let dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.0);

    // Forced target codec differs from the produced body → re-encode directly.
    if force_reencode {
        let target = match out_codec {
            VideoCodec::Hevc => "H.265",
            _ => "H.264",
        };
        let reason = format!("auf {target} (Ziel-Codec)");
        return encode_body_to_output(
            ffmpeg,
            body_path,
            output,
            hw,
            out_codec,
            crf,
            hw_accel_enabled,
            reason,
            "forced_codec_reencode",
            dur,
            &on_progress,
            on_reencode,
        );
    }

    let args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        body_path.to_string(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ];
    let export_cb: ProgressCallback = {
        let outer = Arc::clone(&on_progress);
        Arc::new(move |p: crate::video::progress::EncodeProgress| {
            let mut q = p;
            if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                q.status = "Exportiere Video…".into();
            }
            outer(q);
        })
    };
    match run_ffmpeg(ffmpeg, &args, dur, Arc::clone(&export_cb)) {
        Ok(()) => Ok("copy".into()),
        Err(e) => {
            if is_disk_full_error(&e) {
                return Err(ProcessorError::Ffmpeg(disk_full_error()));
            }
            let reason =
                format!("Remux (Stream-Copy) fehlgeschlagen → Neu-Kodierung als Fallback ({e})");
            encode_body_to_output(
                ffmpeg,
                body_path,
                output,
                hw,
                out_codec,
                crf,
                hw_accel_enabled,
                reason,
                "remux_fallback_reencode",
                dur,
                &on_progress,
                on_reencode,
            )
        }
    }
}

/// Re-encode `body_path` → `output` to `out_codec` (video) + AAC audio.
///
/// Prompts for confirmation via `on_reencode` (recommended profile when silent).
/// When the profile requests HW encode, tries NVENC/VideoToolbox first, then falls
/// back to software (same pattern as CapCut single-pass) — avoids hard fails on
/// machines where the auto format filter + NVENC path returns ENOSYS.
#[allow(clippy::too_many_arguments)]
fn encode_body_to_output(
    ffmpeg: &Path,
    body_path: &str,
    output: &str,
    hw: &HwAccelInfo,
    out_codec: VideoCodec,
    crf: u8,
    hw_accel_enabled: bool,
    reason: String,
    strategy: &str,
    dur: f64,
    on_progress: &ProgressCallback,
    on_reencode: Option<&ReencodeAskFn>,
) -> Result<String, ProcessorError> {
    let (enc, _out_params) = build_encode_output_params(hw, out_codec, crf, !hw_accel_enabled);
    let kind = if strategy == "forced_codec_reencode" {
        ReencodeKind::ForcedCodec
    } else {
        ReencodeKind::RemuxFallback
    };
    let intent = ReencodeIntent::new(kind, reason.clone()).with_params(
        ReencodeParams {
            encoder: Some(enc.clone()),
            crf: Some(crf),
            hw_accel: Some(hw_accel_enabled),
            target_codec: Some(match out_codec {
                VideoCodec::Hevc => "h265".into(),
                VideoCodec::H264 => "h264".into(),
                VideoCodec::Other => "other".into(),
            }),
            strategy: Some(strategy.into()),
            ..Default::default()
        },
    );
    on_progress(progress_from_times(
        0.0,
        100.0,
        "Neu-Kodierung — warte auf Bestätigung…",
    ));
    let profile = reencode_confirm::require_confirm(on_reencode, &intent)
        .map_err(|_| ProcessorError::Ffmpeg(FfmpegError::Cancelled))?;
    // Reset the overall bar to 0 for the encode step; live FFmpeg progress drives it
    // (the "Kodiere neu" label is a reset-stage label on the frontend).
    let encode_label = if strategy == "forced_codec_reencode" {
        // e.g. "Kodiere neu auf H.264 (Ziel-Codec)"
        format!("Kodiere neu {reason}")
    } else {
        format!("Kodiere neu: {reason}")
    };
    on_progress(progress_from_times(0.0, 100.0, &encode_label));
    let reenc_cb: ProgressCallback = {
        let outer = Arc::clone(on_progress);
        let encode_label = encode_label.clone();
        Arc::new(move |p: crate::video::progress::EncodeProgress| {
            let mut q = p;
            if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                q.status = encode_label.clone();
            }
            outer(q);
        })
    };

    let source_pix = probe_body_pix_fmt(ffmpeg, body_path);
    let audio_is_aac = matches!(
        concat::probe_audio_codec(ffmpeg, body_path),
        Ok(Some((ref codec, _))) if codec == "aac" || codec == "mp4a"
    );
    let encode_hw = profile.hw_accel && hw.available;
    let kind = if strategy == "forced_codec_reencode" {
        "encode.forced_codec"
    } else {
        "encode.body_reencode"
    };
    let codec_label = match out_codec {
        VideoCodec::Hevc => "h265",
        VideoCodec::H264 => "h264",
        VideoCodec::Other => "other",
    };
    log_encode_start(
        kind,
        0,
        0,
        "?",
        dur,
        profile.crf,
        encode_hw,
        codec_label,
    );
    let t0 = Instant::now();
    let attempts: &[bool] = if encode_hw {
        &[false, true]
    } else {
        &[true]
    };
    let progress_total = progress_encode_total_secs(&[dur.max(0.05)]);

    let mut last_err: Option<ProcessorError> = None;
    for (attempt_i, &force_sw) in attempts.iter().enumerate() {
        if attempt_i > 0 {
            emit_step_start(on_progress, &encode_label);
            if let Some(ProcessorError::Ffmpeg(ref e)) = last_err {
                log_encode_fallback_sw(kind, e);
            }
        }
        let (encoder, out_params) = if !force_sw {
            profile.to_encode_output_params(hw, out_codec)
        } else {
            build_encode_output_params(hw, out_codec, profile.crf, true)
        };
        log_encode_attempt(kind, attempt_i + 1, force_sw, &encoder);
        let mut args = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-i".into(),
            body_path.to_string(),
        ];
        args.extend(build_body_reencode_mid_args(
            out_codec,
            &source_pix,
            &out_params,
        ));
        args.extend(build_body_reencode_output_tail(audio_is_aac));
        args.extend([
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            output.to_string(),
        ]);
        match run_ffmpeg(ffmpeg, &args, progress_total, Arc::clone(&reenc_cb)) {
            Ok(()) => {
                log_encode_ok(kind, &encoder, t0.elapsed().as_millis(), strategy);
                return Ok(encoder);
            }
            Err(e) => {
                if is_disk_full_error(&e) {
                    return Err(ProcessorError::Ffmpeg(disk_full_error()));
                }
                last_err = Some(ProcessorError::Ffmpeg(e));
                let _ = fs::remove_file(output);
            }
        }
    }
    if let Some(ref e) = last_err {
        log_encode_fail(kind, e);
    }
    Err(last_err.unwrap_or_else(|| {
        ProcessorError::Message("body re-encode failed".into())
    }))
}

fn probe_body_pix_fmt(ffmpeg: &Path, body_path: &str) -> String {
    ffmpeg_probe_stderr(ffmpeg, body_path)
        .ok()
        .and_then(|s| probe::parse_pix_fmt_from_probe(&s))
        .unwrap_or_default()
}

/// True when the source is already phone-safe 8-bit 4:2:0 (no convert needed for H.264).
fn source_pix_fmt_is_phone_safe_8bit(pix_fmt: &str) -> bool {
    matches!(
        pix_fmt.trim().to_ascii_lowercase().as_str(),
        "yuv420p" | "yuvj420p" | "nv12"
    )
}

/// H.264 targets need an explicit 8-bit convert when the source is not already safe
/// (e.g. 10-bit HEVC → avoid libx264 High 10 / NVENC auto-filter ENOSYS).
fn h264_needs_yuv420_convert(out_codec: VideoCodec, source_pix_fmt: &str) -> bool {
    matches!(out_codec, VideoCodec::H264) && !source_pix_fmt_is_phone_safe_8bit(source_pix_fmt)
}

/// Mid args after `-i`: optional explicit CPU format filter + encoder params.
///
/// When converting to H.264 from a non-8-bit-420 source, insert `-vf format=yuv420p`
/// *before* `-c:v` so NVENC/libx264 get a stable CPU conversion (avoids fragile
/// auto-inserted `vf` graphs that fail with ENOSYS on some Windows/NVIDIA setups).
fn build_body_reencode_mid_args(
    out_codec: VideoCodec,
    source_pix_fmt: &str,
    out_params: &[String],
) -> Vec<String> {
    let mut mid: Vec<String> = Vec::new();
    if h264_needs_yuv420_convert(out_codec, source_pix_fmt) {
        mid.extend(["-vf".into(), "format=yuv420p".into()]);
        mid.extend(out_params.iter().cloned());
        mid.extend(["-pix_fmt".into(), "yuv420p".into()]);
    } else {
        mid.extend(out_params.iter().cloned());
    }
    mid
}

/// Output-tail args for a forced body re-encode (audio + faststart; pure; unit-tested).
///
/// Pixelformat conversion lives in [`build_body_reencode_mid_args`] (only when needed).
fn build_body_reencode_output_tail(audio_is_aac: bool) -> Vec<String> {
    let mut tail: Vec<String> = Vec::new();
    if audio_is_aac {
        tail.extend(["-c:a".into(), "copy".into()]);
    } else {
        tail.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    tail.extend(["-movflags".into(), "+faststart".into()]);
    tail
}

fn create_intro_clip(
    ffmpeg: &Path,
    hintergrund: &str,
    output: &str,
    dauer: f64,
    v_params: &IntroVideoParams,
    drawtext: &str,
    hw: &HwAccelInfo,
    crf: u8,
    hw_accel_enabled: bool,
    on_progress: ProgressCallback,
) -> Result<(), ProcessorError> {
    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };

    let mut last_err: Option<ProcessorError> = None;
    let attempts: &[bool] = if hw_accel_enabled {
        &[false, true]
    } else {
        &[true]
    };
    for (attempt_i, &force_sw) in attempts.iter().enumerate() {
        if attempt_i > 0 {
            emit_step_start(&on_progress, "Erstelle Intro…");
        }
        let (encoder, _) = build_encode_output_params(hw, codec, crf, force_sw);
        let use_hw = hw.available && !force_sw;
        let quality = intro_quality_params(&encoder, crf, use_hw);
        let args = build_intro_ffmpeg_args(
            hintergrund,
            output,
            dauer,
            v_params,
            drawtext,
            &encoder,
            &quality,
        );
        match run_ffmpeg_tagged(ffmpeg, &args, dauer, Some(1), Arc::clone(&on_progress)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(ProcessorError::Ffmpeg(e));
                let _ = fs::remove_file(output);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| ProcessorError::Message("intro encode failed".into())))
}

fn quality_params_without_codec(output_params: Vec<String>) -> Vec<String> {
    let mut q = output_params;
    if q.first().map(|s| s.as_str()) == Some("-c:v") && q.len() >= 2 {
        q.drain(0..2);
    }
    q
}

/// OPT-21 Slice 0: structured CapCut / forced-encode diagnostics (source `encode`).
fn log_encode_start(
    kind: &str,
    width: u32,
    height: u32,
    fps: &str,
    duration_secs: f64,
    crf: u8,
    hw_accel: bool,
    codec: &str,
) {
    logging::info(
        "encode",
        format!(
            "{kind}.start codec={codec} hw={hw_accel} crf={crf} {width}x{height}@{fps} dur_s={duration_secs:.2}"
        ),
    );
}

fn log_encode_attempt(kind: &str, attempt: usize, force_sw: bool, encoder: &str) {
    logging::info(
        "encode",
        format!("{kind}.attempt #{attempt} force_sw={force_sw} encoder={encoder}"),
    );
}

fn log_encode_fallback_sw(kind: &str, err: &FfmpegError) {
    // Full FFmpeg stderr was already logged by ffmpeg_exit_error; summarize here.
    let summary = err.to_string();
    let first_line = summary.lines().next().unwrap_or("unknown");
    logging::warn(
        "encode",
        format!("{kind}.fallback_sw after HW fail: {first_line} (see prior [ffmpeg] ERROR for full stderr)"),
    );
}

fn log_encode_ok(kind: &str, encoder: &str, elapsed_ms: u128, method: &str) {
    logging::info(
        "encode",
        format!("{kind}.ok encoder={encoder} elapsed_ms={elapsed_ms} method={method}"),
    );
}

fn log_encode_fail(kind: &str, err: &impl std::fmt::Display) {
    logging::error("encode", format!("{kind}.fail: {err}"));
}

/// Single-pass Intro+Body encode (one bitstream). Optionally stream-copies body AAC.
///
/// When `encode_profile` is set (CapCut export), uses [`EncodeProfile::to_encode_output_params`]
/// and HEVC customer tags (`hvc1`). Otherwise legacy crf/hw params (single-pass dialog path).
fn mux_intro_body_single_pass(
    ffmpeg: &Path,
    hintergrund: &str,
    body_path: &str,
    output: &str,
    intro_dauer: f64,
    v_params: &IntroVideoParams,
    drawtext: &str,
    hw: &HwAccelInfo,
    crf: u8,
    hw_accel_enabled: bool,
    encode_profile: Option<&EncodeProfile>,
    body_source: Option<&CapcutSourceVideo>,
    work: &Path,
    on_progress: ProgressCallback,
) -> Result<concat::ConcatOutcome, ConcatError> {
    if is_cancelled() {
        return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
    }

    let has_audio = concat::probe_has_audio(ffmpeg, body_path)?;
    let body_dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.0).max(0.05);
    let intro_dauer = intro_dauer.max(0.1);
    // Small headroom: short/wrong container duration must not make the bar race to 99%
    // in the first seconds (live ticks are also capped at 99% until FFmpeg `end`).
    let total = progress_encode_total_secs(&[intro_dauer, body_dur]);
    let copy_audio = has_audio && body_audio_is_aac_copyable(v_params);

    let audio_mode = if copy_audio {
        SinglePassAudioMode::VideoOnly
    } else if has_audio {
        SinglePassAudioMode::EncodeAac
    } else {
        SinglePassAudioMode::EncodeSilence
    };

    let video_target = if copy_audio {
        work.join("single_pass_video.mp4")
            .to_string_lossy()
            .into_owned()
    } else {
        output.to_string()
    };

    let capcut = encode_profile.is_some();
    let intro_label = if capcut {
        if copy_audio {
            "Exportiere Intro+Video (Universal, Audio-Copy)…"
        } else {
            "Exportiere Intro+Video (Universal)…"
        }
    } else if copy_audio {
        "Kodiere Intro+Video (Audio-Copy)…"
    } else {
        "Kodiere Intro+Video (kompatibel)…"
    };
    emit_step_start(&on_progress, intro_label);

    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };

    let encode_hw = encode_profile.map(|p| p.hw_accel).unwrap_or(hw_accel_enabled);
    let kind = if capcut {
        "capcut.intro_body"
    } else {
        "encode.intro_body"
    };
    let encode_crf_log = encode_profile.map(|p| p.crf).unwrap_or(crf);
    log_encode_start(
        kind,
        v_params.width,
        v_params.height,
        &v_params.fps,
        intro_dauer + body_dur,
        encode_crf_log,
        encode_hw,
        &v_params.vcodec,
    );
    let t0 = Instant::now();
    let mut last_err: Option<ConcatError> = None;
    let attempts: &[bool] = if encode_hw {
        &[false, true]
    } else {
        &[true]
    };
    let mut encoder_used = String::new();
    let mut encoded = false;
    for (attempt_i, &force_sw) in attempts.iter().enumerate() {
        if attempt_i > 0 {
            // HW failed → SW retry: reset overall bar (monotonic UI would stay at 99%/100%).
            emit_step_start(&on_progress, intro_label);
            if let Some(ConcatError::Ffmpeg(ref e)) = last_err {
                log_encode_fallback_sw(kind, e);
            }
        }
        let encode_crf = encode_profile.map(|p| p.crf).unwrap_or(crf);
        let (encoder, mut out_params) = match encode_profile {
            Some(profile) if !force_sw => profile.to_encode_output_params(hw, codec),
            _ => build_encode_output_params(hw, codec, encode_crf, force_sw),
        };
        log_encode_attempt(kind, attempt_i + 1, force_sw, &encoder);
        if capcut {
            // avc1 tag + closed GOP + repeat-headers/AUD → maximal phone/QuickTime safety.
            let fps_int = parse_fps_int(&v_params.fps);
            append_capcut_splice_encode_params(&mut out_params, codec, &encoder, fps_int);
        }
        let quality = quality_params_without_codec(out_params);
        let target_pix = match v_params.pix_fmt.as_str() {
            "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.as_str(),
            _ => "yuv420p",
        };
        let body_plan = capcut_normalize_plan(body_source, v_params, target_pix);
        let body_hwaccel = if !force_sw && encode_hw {
            capcut_hwaccel_for_decode(hw, body_plan)
        } else {
            None
        };
        if capcut && attempt_i == 0 {
            log_capcut_filter_plan("body", body_plan, body_hwaccel);
        }
        let args = build_intro_body_single_pass_args(
            hintergrund,
            body_path,
            &video_target,
            intro_dauer,
            body_dur,
            v_params,
            drawtext,
            &encoder,
            &quality,
            audio_mode,
            body_source,
            body_hwaccel,
        );
        match run_ffmpeg(ffmpeg, &args, total, Arc::clone(&on_progress)) {
            Ok(()) => {
                encoder_used = encoder;
                encoded = true;
                break;
            }
            Err(e) => {
                last_err = Some(ConcatError::Ffmpeg(e));
                let _ = fs::remove_file(&video_target);
            }
        }
    }
    if !encoded {
        if let Some(ref e) = last_err {
            log_encode_fail(kind, e);
        }
        return Err(last_err.unwrap_or_else(|| ConcatError::NeedsReencode {
            reason: "Intro+Body Single-Pass-Kodierung fehlgeschlagen".into(),
        }));
    }

    if copy_audio {
        assemble_silent_plus_body_audio(
            ffmpeg,
            body_path,
            &video_target,
            output,
            intro_dauer,
            0.0,
            v_params,
            work,
            on_progress,
        )?;
        let _ = fs::remove_file(&video_target);
    }

    let method: String = if capcut {
        if copy_audio {
            "capcut-export+acopy".into()
        } else {
            "capcut-export".into()
        }
    } else if copy_audio {
        "single-pass-reencode+acopy".into()
    } else {
        "single-pass-reencode".into()
    };
    log_encode_ok(kind, &encoder_used, t0.elapsed().as_millis(), &method);
    Ok(concat::ConcatOutcome {
        method,
        codec: encoder_used,
        reencode_reason: if capcut {
            Some("Universal-Export — ein Durchlauf".into())
        } else {
            Some("Intro+Body durchgängig kodieren (kundenkompatibel)".into())
        },
    })
}

fn assemble_silent_plus_body_audio(
    ffmpeg: &Path,
    body_path: &str,
    video_path: &str,
    output: &str,
    intro_dauer: f64,
    trail_silence: f64,
    v_params: &IntroVideoParams,
    work: &Path,
    on_progress: ProgressCallback,
) -> Result<(), ConcatError> {
    let silent = work.join("intro_silence.m4a");
    let silent_s = silent.to_string_lossy().to_string();
    let body_a = work.join("body_audio.m4a");
    let body_a_s = body_a.to_string_lossy().to_string();
    let trail = work.join("outro_silence.m4a");
    let trail_s = trail.to_string_lossy().to_string();
    let full_a = work.join("full_audio.m4a");
    let full_a_s = full_a.to_string_lossy().to_string();

    emit_step_start(&on_progress, "Audio anhängen (Copy)…");

    let intro_dauer = intro_dauer.max(0.0);
    let trail_silence = trail_silence.max(0.0);
    let body_dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.05).max(0.05);
    let video_dur = probe_duration_secs(ffmpeg, video_path)
        .unwrap_or(intro_dauer + body_dur + trail_silence)
        .max(0.1);

    let mut concat_parts: Vec<&str> = Vec::with_capacity(3);

    if intro_dauer > 0.05 {
        let mut silent_args = build_silent_aac_args(
            &silent_s,
            intro_dauer,
            &v_params.sample_rate,
            &v_params.channel_layout,
        );
        push_ffmpeg_progress_args(&mut silent_args);
        run_ffmpeg(
            ffmpeg,
            &silent_args,
            intro_dauer,
            map_substep_progress(Arc::clone(&on_progress), 0.0, 30.0),
        )
        .map_err(ConcatError::Ffmpeg)?;
        concat_parts.push(&silent_s);
    }

    on_progress(progress_from_times(35.0, 100.0, "Audio anhängen (Copy)…"));

    let extract_args = build_extract_audio_copy_args(body_path, &body_a_s);
    run_ffmpeg_checked(ffmpeg, &extract_args).map_err(ConcatError::Ffmpeg)?;
    concat_parts.push(&body_a_s);

    on_progress(progress_from_times(45.0, 100.0, "Audio anhängen (Copy)…"));

    if trail_silence > 0.05 {
        let mut trail_args = build_silent_aac_args(
            &trail_s,
            trail_silence,
            &v_params.sample_rate,
            &v_params.channel_layout,
        );
        push_ffmpeg_progress_args(&mut trail_args);
        run_ffmpeg(
            ffmpeg,
            &trail_args,
            trail_silence,
            map_substep_progress(Arc::clone(&on_progress), 45.0, 55.0),
        )
        .map_err(ConcatError::Ffmpeg)?;
        concat_parts.push(&trail_s);
    }

    let list_path = work.join("audio_concat.txt");
    concat::write_concat_file_list(&concat_parts, &list_path)?;
    let audio_concat_dur = intro_dauer + body_dur + trail_silence;
    let mut concat_args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string_lossy().into_owned(),
        "-c".into(),
        "copy".into(),
    ];
    push_ffmpeg_progress_args(&mut concat_args);
    concat_args.push(full_a_s.clone());
    run_ffmpeg(
        ffmpeg,
        &concat_args,
        audio_concat_dur.max(0.1),
        map_substep_progress(Arc::clone(&on_progress), 55.0, 75.0),
    )
    .map_err(ConcatError::Ffmpeg)?;

    let mut mux_args = build_mux_video_audio_copy_args(video_path, &full_a_s, output);
    push_ffmpeg_progress_args(&mut mux_args);
    run_ffmpeg(
        ffmpeg,
        &mux_args,
        video_dur,
        map_substep_progress(on_progress, 75.0, 100.0),
    )
    .map_err(ConcatError::Ffmpeg)?;
    Ok(())
}

/// Phase 50: CapCut single-pass mux — `[Intro?] → Body → Outro` in one continuous encode
/// (same principle as Intro-only: body encoded once; optional AAC audio-copy afterward).
#[allow(clippy::too_many_arguments)]
fn mux_with_outro(
    ffmpeg: &Path,
    intro: Option<(&str, &str, f64)>,
    body_path: &str,
    outro_path: &str,
    outro_kind: OutroKind,
    outro_dauer: f64,
    output: &str,
    v_params: &IntroVideoParams,
    hw: &HwAccelInfo,
    capcut_profile: &EncodeProfile,
    body_source: Option<&CapcutSourceVideo>,
    work: &Path,
    on_progress: ProgressCallback,
) -> Result<concat::ConcatOutcome, ProcessorError> {
    if is_cancelled() {
        return Err(ProcessorError::Ffmpeg(FfmpegError::Cancelled));
    }
    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };
    let fps_int = parse_fps_int(&v_params.fps);

    let body_has_audio = concat::probe_has_audio(ffmpeg, body_path).unwrap_or(false);
    let body_dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.0).max(0.05);
    let intro_dauer = intro.map(|(_, _, d)| d.max(0.1)).unwrap_or(0.0);

    let outro_has_audio = match outro_kind {
        OutroKind::Photo => false,
        OutroKind::Video => concat::probe_has_audio(ffmpeg, outro_path).unwrap_or(false),
    };
    let outro_eff_dauer = match outro_kind {
        OutroKind::Photo => outro_dauer.max(0.1),
        OutroKind::Video => probe_duration_secs(ffmpeg, outro_path).unwrap_or(0.0).max(0.05),
    };
    let outro_input = SinglePassOutroInput {
        path: outro_path.to_string(),
        kind: outro_kind,
        dauer: outro_eff_dauer,
        has_audio: outro_has_audio,
    };

    // AAC copy only when body audio is copyable AND Outro does not bring its own audio
    // (photo / silent video → trailing silence via stream-copy assemble).
    let copy_audio = body_has_audio
        && body_audio_is_aac_copyable(v_params)
        && !outro_has_audio;

    let audio_mode = if copy_audio {
        SinglePassAudioMode::VideoOnly
    } else if body_has_audio {
        SinglePassAudioMode::EncodeAac
    } else {
        SinglePassAudioMode::EncodeSilence
    };

    let video_target = if copy_audio {
        work.join("single_pass_outro_video.mp4")
            .to_string_lossy()
            .into_owned()
    } else {
        output.to_string()
    };

    let label: &'static str = if intro.is_some() {
        if copy_audio {
            "Exportiere Intro+Video+Outro (Universal, Audio-Copy)…"
        } else {
            "Exportiere Intro+Video+Outro (Universal)…"
        }
    } else if copy_audio {
        "Exportiere Video+Outro (Universal, Audio-Copy)…"
    } else {
        "Exportiere Video+Outro (Universal)…"
    };
    // First tick must match VIDEO_STEP_START_RESET (incl. older frontends that only
    // know Intro+Video Universal). A 0 % Outro label alone would not lower the bar
    // after "Videoclips vorbereitet" @ 100 % (monotonic UI).
    emit_step_start(
        &on_progress,
        "Exportiere Intro+Video (Universal)…",
    );
    on_progress(progress_from_times(0.0, 100.0, label));

    let total = progress_encode_total_secs(&[intro_dauer, body_dur, outro_eff_dauer]);
    let encode_hw = capcut_profile.hw_accel;
    let kind = if intro.is_some() {
        "capcut.intro_body_outro"
    } else {
        "capcut.body_outro"
    };
    log_encode_start(
        kind,
        v_params.width,
        v_params.height,
        &v_params.fps,
        intro_dauer + body_dur + outro_eff_dauer,
        capcut_profile.crf,
        encode_hw,
        &v_params.vcodec,
    );
    let t0 = Instant::now();
    let attempts: &[bool] = if encode_hw {
        &[false, true]
    } else {
        &[true]
    };
    let mut last_err: Option<ProcessorError> = None;
    let mut encoder_used = String::new();
    let mut encoded = false;
    for (attempt_i, &force_sw) in attempts.iter().enumerate() {
        if attempt_i > 0 {
            emit_step_start(
                &on_progress,
                "Exportiere Intro+Video (Universal)…",
            );
            on_progress(progress_from_times(0.0, 100.0, label));
            if let Some(ProcessorError::Ffmpeg(ref e)) = last_err {
                log_encode_fallback_sw(kind, e);
            }
        }
        let (encoder, mut out_params) = if !force_sw {
            capcut_profile.to_encode_output_params(hw, codec)
        } else {
            build_encode_output_params(hw, codec, capcut_profile.crf, true)
        };
        log_encode_attempt(kind, attempt_i + 1, force_sw, &encoder);
        append_capcut_splice_encode_params(&mut out_params, codec, &encoder, fps_int);
        let quality = quality_params_without_codec(out_params);
        let target_pix = match v_params.pix_fmt.as_str() {
            "yuv420p" | "yuvj420p" | "yuv420p10le" => v_params.pix_fmt.as_str(),
            _ => "yuv420p",
        };
        let body_plan = capcut_normalize_plan(body_source, v_params, target_pix);
        let body_hwaccel = if !force_sw && encode_hw {
            capcut_hwaccel_for_decode(hw, body_plan)
        } else {
            None
        };
        if attempt_i == 0 {
            log_capcut_filter_plan("body", body_plan, body_hwaccel);
        }
        let args = build_intro_body_outro_single_pass_args(
            intro,
            body_path,
            body_dur,
            &outro_input,
            &video_target,
            v_params,
            &encoder,
            &quality,
            audio_mode,
            body_source,
            None, // outro geometry not probed here — full normalize (safe)
            body_hwaccel,
        );
        match run_ffmpeg(ffmpeg, &args, total, Arc::clone(&on_progress)) {
            Ok(()) => {
                encoder_used = encoder;
                encoded = true;
                break;
            }
            Err(e) => {
                if is_disk_full_error(&e) {
                    return Err(ProcessorError::Ffmpeg(disk_full_error()));
                }
                last_err = Some(ProcessorError::Ffmpeg(e));
                let _ = fs::remove_file(&video_target);
            }
        }
    }
    if !encoded {
        if let Some(ref e) = last_err {
            log_encode_fail(kind, e);
        }
        return Err(last_err
            .unwrap_or_else(|| ProcessorError::Message("Outro-Zusammenfügen fehlgeschlagen".into())));
    }

    if copy_audio {
        assemble_silent_plus_body_audio(
            ffmpeg,
            body_path,
            &video_target,
            output,
            intro_dauer,
            outro_eff_dauer,
            v_params,
            work,
            on_progress,
        )?;
        let _ = fs::remove_file(&video_target);
    }

    let method: String = if intro.is_some() {
        if copy_audio {
            "capcut-export+outro+acopy".into()
        } else {
            "capcut-export+outro".into()
        }
    } else if copy_audio {
        "capcut-export-outro+acopy".into()
    } else {
        "capcut-export-outro".into()
    };
    log_encode_ok(kind, &encoder_used, t0.elapsed().as_millis(), &method);
    Ok(concat::ConcatOutcome {
        method,
        codec: encoder_used,
        reencode_reason: Some("Universal-Export Outro — ein Durchlauf".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.gast = "Max Mustermann".into();
        k.tandemmaster = "Anna".into();
        k.videospringer = "Bob".into();
        k.datum = "06.08.2026".into();
        k.ort = "Calden".into();
        k.outside_video = true;
        k
    }

    #[test]
    fn content_area_1080p_is_reasonable() {
        let area = calculate_scaled_content_area(1920, 1080);
        assert!(area.usable_width > 400);
        assert!(area.usable_height > 400);
        assert!(area.x_start >= 0);
        assert!(area.y_start >= 0);
        assert!(area.x_start + area.usable_width <= 1920);
        assert!(area.y_start + area.usable_height <= 1080);
    }

    #[test]
    fn drawtext_contains_labels_and_values() {
        let filter = prepare_text_overlay(&sample_kunde(), 1920, 1080);
        assert!(filter.contains("drawtext="));
        assert!(filter.contains("Gast"));
        assert!(filter.contains("Max Mustermann") || filter.contains("Mustermann"));
    }

    #[test]
    fn build_intro_args_structure() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let args = build_intro_ffmpeg_args(
            r"C:\assets\bg.png",
            r"C:\out\intro.mp4",
            5.0,
            &v,
            "drawtext=text='x'",
            "libx264",
            &quality,
        );
        assert!(args.contains(&"-loop".into()));
        assert!(args.contains(&"-vf".into()));
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"-force_key_frames".into()));
        assert_eq!(args.last().unwrap(), r"C:\out\intro.mp4");
    }

    #[test]
    fn single_pass_args_structure_encode_aac() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let args = build_intro_body_single_pass_args(
            r"C:\assets\bg.png",
            r"C:\body.mp4",
            r"C:\out\final.mp4",
            5.0,
            10.0,
            &v,
            "drawtext=text='Gast'",
            "libx264",
            &quality,
            SinglePassAudioMode::EncodeAac,
            None,
            None,
        );
        assert!(args.contains(&"-filter_complex".into()));
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        assert!(fc.contains("concat=n=2:v=1:a=0"));
        assert!(fc.contains("trim=duration=5"));
        assert!(!fc.contains("trim=duration=10"));
        assert!(fc.contains("[1:a]"));
        assert!(fc.matches("setsar=1").count() >= 2);
        assert!(args.contains(&"aac".into()));
        assert!(args.iter().any(|a| a == "15" || a.starts_with("15.")));
        assert_eq!(args.last().unwrap(), r"C:\out\final.mp4");
    }

    #[test]
    fn single_pass_args_video_only_for_audio_copy() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let args = build_intro_body_single_pass_args(
            "bg.png",
            "body.mp4",
            "v.mp4",
            3.0,
            7.0,
            &v,
            "drawtext=text='x'",
            "libx264",
            &quality,
            SinglePassAudioMode::VideoOnly,
            None,
            None,
        );
        assert!(args.contains(&"-an".into()));
        assert!(!args.iter().any(|a| a == "[a]"));
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .unwrap();
        assert!(!fc.contains("[1:a]"));
    }

    #[test]
    fn body_audio_aac_copyable_detection() {
        let mut v = IntroVideoParams::for_1080p30("h264");
        assert!(body_audio_is_aac_copyable(&v));
        v.acodec = "mp4a".into();
        assert!(body_audio_is_aac_copyable(&v));
        v.acodec = "pcm_s16le".into();
        assert!(!body_audio_is_aac_copyable(&v));
    }

    #[test]
    fn silent_aac_and_mux_arg_builders() {
        let silent = build_silent_aac_args("silent.m4a", 5.0, "48000", "stereo");
        assert!(silent.contains(&"anullsrc=channel_layout=stereo:sample_rate=48000".into()));
        assert!(silent.contains(&"aac".into()));

        let extract = build_extract_audio_copy_args("body.mp4", "a.m4a");
        assert!(extract.contains(&"-vn".into()));
        assert!(extract.contains(&"copy".into()));

        let mux = build_mux_video_audio_copy_args("v.mp4", "a.m4a", "out.mp4");
        assert!(mux.contains(&"+faststart".into()));
        assert_eq!(mux.iter().filter(|a| *a == "copy").count(), 2);
    }

    #[test]
    fn intro_params_from_probe_stderr() {
        let stderr = "  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps, 30 tbr, 90k tbn\n  Stream #0:1: Audio: aac, 48000 Hz, stereo";
        let p = intro_params_from_probe(stderr, "h264");
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        assert_eq!(p.pix_fmt, "yuv420p");
    }

    #[test]
    fn intro_mux_mode_detection() {
        assert_eq!(normalized_intro_mux_mode("stream_copy"), "capcut");
        assert_eq!(normalized_intro_mux_mode("reencode"), "capcut");
        assert_eq!(normalized_intro_mux_mode("capcut"), "capcut");
        assert_eq!(normalized_intro_mux_mode("universal"), "capcut");
        assert_eq!(normalized_intro_mux_mode("single_pass"), "capcut");
        assert_eq!(normalized_intro_mux_mode("soft_splice"), "capcut");
    }

    #[test]
    fn forced_reencode_only_on_codec_mismatch() {
        use crate::video::encoding_quality::VideoCodecPreference as P;
        // Auto never forces a re-encode (stream-copy keeps the source codec).
        assert!(!body_needs_forced_reencode(P::Auto, "h264"));
        assert!(!body_needs_forced_reencode(P::Auto, "hevc"));
        // Forced codec == source codec → stream-copy stays.
        assert!(!body_needs_forced_reencode(P::H264, "h264"));
        assert!(!body_needs_forced_reencode(P::H265, "hevc"));
        assert!(!body_needs_forced_reencode(P::H265, "hev1"));
        // Forced codec ≠ source codec → must re-encode.
        assert!(body_needs_forced_reencode(P::H265, "h264"));
        assert!(body_needs_forced_reencode(P::H264, "hevc"));
        // Exotic/unknown source with a forced target → re-encode to target.
        assert!(body_needs_forced_reencode(P::H264, "vp9"));
        assert!(body_needs_forced_reencode(P::H265, "av1"));
    }

    #[test]
    fn defer_forced_reencode_skips_export_force_flag() {
        use crate::video::encoding_quality::VideoCodecPreference as P;
        // Mirrors create_video: mismatch + defer → no force_reencode at staging time.
        let mismatch = body_needs_forced_reencode(P::H264, "hevc");
        assert!(mismatch);
        let defer = true;
        assert!(!(mismatch && !defer));
        let defer = false;
        assert!(mismatch && !defer);
    }

    #[test]
    fn progress_encode_total_adds_headroom() {
        let t = progress_encode_total_secs(&[5.0, 95.0]);
        assert!((t - 105.0).abs() < 0.01);
        assert!((progress_encode_total_secs(&[0.0]) - 0.1).abs() < 0.001);
    }

    #[test]
    fn body_reencode_tail_aac_copy_vs_transcode() {
        let copy = build_body_reencode_output_tail(true);
        assert!(copy.windows(2).any(|w| w[0] == "-c:a" && w[1] == "copy"));
        assert!(!copy.iter().any(|a| a == "192k"));
        assert!(copy.contains(&"+faststart".into()));

        let enc = build_body_reencode_output_tail(false);
        assert!(enc.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        assert!(enc.windows(2).any(|w| w[0] == "-b:a" && w[1] == "192k"));
    }

    #[test]
    fn h264_yuv420_convert_only_when_source_not_safe() {
        assert!(!h264_needs_yuv420_convert(VideoCodec::H264, "yuv420p"));
        assert!(!h264_needs_yuv420_convert(VideoCodec::H264, "yuvj420p"));
        assert!(!h264_needs_yuv420_convert(VideoCodec::H264, "nv12"));
        assert!(h264_needs_yuv420_convert(VideoCodec::H264, "yuv420p10le"));
        assert!(h264_needs_yuv420_convert(VideoCodec::H264, "p010le"));
        assert!(h264_needs_yuv420_convert(VideoCodec::H264, ""));
        // HEVC target never forces the H.264 8-bit convert.
        assert!(!h264_needs_yuv420_convert(VideoCodec::Hevc, "yuv420p10le"));
    }

    #[test]
    fn body_reencode_mid_args_inserts_vf_only_when_converting() {
        let enc = vec!["-c:v".into(), "h264_nvenc".into(), "-preset".into(), "p4".into()];
        // Already safe → no vf / pix_fmt.
        let mid_safe = build_body_reencode_mid_args(VideoCodec::H264, "yuv420p", &enc);
        assert!(!mid_safe.iter().any(|a| a == "-vf"));
        assert!(!mid_safe.iter().any(|a| a == "-pix_fmt"));
        assert!(mid_safe.contains(&"h264_nvenc".into()));

        // 10-bit source → explicit CPU format filter before encoder + output pix_fmt.
        let mid_10 = build_body_reencode_mid_args(VideoCodec::H264, "yuv420p10le", &enc);
        assert!(mid_10.windows(2).any(|w| w[0] == "-vf" && w[1] == "format=yuv420p"));
        assert!(mid_10.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p"));
        // -vf must come before -c:v so NVENC sees converted frames.
        let vf_i = mid_10.iter().position(|a| a == "-vf").unwrap();
        let cv_i = mid_10.iter().position(|a| a == "-c:v").unwrap();
        assert!(vf_i < cv_i);

        // HEVC: never inject H.264 convert.
        let mid_hevc = build_body_reencode_mid_args(VideoCodec::Hevc, "yuv420p10le", &enc);
        assert!(!mid_hevc.iter().any(|a| a == "-vf"));
    }

    #[test]
    fn map_substep_progress_scales_within_step() {
        let last = Arc::new(std::sync::Mutex::new(None::<f64>));
        let sink: ProgressCallback = {
            let last = Arc::clone(&last);
            Arc::new(move |p: crate::video::progress::EncodeProgress| {
                *last.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.percent);
            })
        };
        let cb = map_substep_progress(sink, 50.0, 100.0);
        cb(progress_from_times(50.0, 100.0, "continue"));
        let pct = last.lock().unwrap_or_else(|e| e.into_inner()).unwrap();
        assert!((pct - 75.0).abs() < 0.01);
    }

    #[test]
    fn drawtext_escapes_and_labels() {
        let filter = prepare_text_overlay(&sample_kunde(), 1920, 1080);
        assert!(filter.contains("Gast\\:") || filter.contains("Gast"));
        assert!(filter.contains("Max"));
        assert!(filter.contains("Mustermann"));
        assert!(filter.contains("Videospringer\\:") || filter.contains("Videospringer"));
        assert!(filter.contains("Calden"));
        assert!(filter.contains("fontcolor=white"));
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        assert!(filter.contains("font='"), "Win/Mac should use font= name");
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            assert!(
                filter.contains("fontfile='") || filter.contains("font='"),
                "Linux should prefer fontfile= when a TTF exists"
            );
        }
    }

    #[test]
    fn linux_fontfile_candidates_include_dejavu_and_bundle() {
        let c = linux_fontfile_candidates();
        assert!(!c.is_empty());
        let joined: Vec<String> = c
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(joined.iter().any(|p| p.contains("assets/fonts/DejaVuSans.ttf")));
        assert!(joined
            .iter()
            .any(|p| p.contains("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")));
    }

    #[test]
    fn ffmpeg_escape_fontfile_path_normalises_and_escapes() {
        // Linux-style paths (fontfile= is Linux-only); colon in filename must be escaped.
        let escaped =
            ffmpeg_escape_fontfile_path("/usr/share/fonts/truetype/dejavu/DejaVu:Sans.ttf");
        assert!(escaped.contains("/usr/share/fonts/truetype/dejavu/"));
        assert!(
            escaped.contains(r"DejaVu\:Sans"),
            "colon in path must be escaped for FFmpeg filters: {escaped}"
        );
        let win_style = ffmpeg_escape_fontfile_path(r"C:\Fonts\DejaVuSans.ttf");
        assert!(
            win_style.contains("C:/Fonts/DejaVuSans.ttf")
                || win_style.contains(r"C\:/Fonts/DejaVuSans.ttf"),
            "backslashes normalised; drive colon may be escaped: {win_style}"
        );
    }

    #[test]
    fn drawtext_hides_videospringer_when_not_outside() {
        let mut k = sample_kunde();
        k.outside_video = false;
        let filter = prepare_text_overlay(&k, 1920, 1080);
        assert!(!filter.contains("Videospringer"));
    }

    #[test]
    fn intro_params_probe_timescale_and_audio() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'body.mp4':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 7970 kb/s, 30 fps, 30 tbr, 90k tbn
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
"#;
        let p = intro_params_from_probe(stderr, "h264");
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        assert_eq!(p.pix_fmt, "yuv420p");
        assert_eq!(p.sample_rate, "48000");
        assert_eq!(p.acodec, "aac");
        assert_eq!(p.timescale, "90000");
    }

    #[test]
    fn find_asset_hintergrund_in_dev() {
        let path = find_asset(ASSET_HINTERGRUND, None).expect("hintergrund.png");
        assert!(path.exists());
        assert!(path.file_name().unwrap() == "hintergrund.png");
    }

    #[test]
    fn ffmpeg_escape_colon() {
        assert_eq!(ffmpeg_escape_text("a:b"), r"a\:b");
    }

    #[test]
    fn capcut_export_profile_fast_presets_per_target() {
        // Auto/H.264 target → H.264; explicit H.265 target → HEVC. Fast preset either way.
        let h264 = EncodeProfile::capcut_export(true, 18, "h264");
        assert_eq!(h264.resolved_codec.as_deref(), Some("h264"));
        assert_eq!(h264.sw_preset, "superfast");
        assert_eq!(h264.crf, 18);
        let hevc = EncodeProfile::capcut_export(true, 18, "h265");
        assert_eq!(hevc.resolved_codec.as_deref(), Some("h265"));
        assert_eq!(hevc.sw_preset, "superfast");
    }

    #[test]
    fn build_body_clip_encode_args_structure() {
        let params = IntroVideoParams::for_1080p30("h264");
        let quality = vec!["-preset".into(), "medium".into(), "-crf".into(), "18".into()];
        let args = build_body_clip_encode_args("in.mp4", "out.mp4", &params, "libx264", &quality);
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"in.mp4".into()));
        assert!(args.contains(&"-c:v".into()));
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"-progress".into()));
        assert!(args.iter().any(|a| a.contains("scale=1920:1080")));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn outro_media_kind_from_extension() {
        assert_eq!(outro_media_kind("clip.mp4"), OutroKind::Video);
        assert_eq!(outro_media_kind(r"C:\a\OUTRO.MOV"), OutroKind::Video);
        assert_eq!(outro_media_kind("logo.png"), OutroKind::Photo);
        assert_eq!(outro_media_kind("shot.JPEG"), OutroKind::Photo);
        // Unknown / no extension → treated as photo (safe still + silence).
        assert_eq!(outro_media_kind("weird.xyz"), OutroKind::Photo);
        assert_eq!(outro_media_kind("noext"), OutroKind::Photo);
    }

    #[test]
    fn intro_body_outro_single_pass_photo_with_intro() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let outro = SinglePassOutroInput {
            path: r"C:\assets\outro.png".into(),
            kind: OutroKind::Photo,
            dauer: 4.0,
            has_audio: false,
        };
        let args = build_intro_body_outro_single_pass_args(
            Some((r"C:\assets\bg.png", "drawtext=text='Gast'", 5.0)),
            r"C:\body.mp4",
            60.0,
            &outro,
            r"C:\out\final.mp4",
            &v,
            "libx264",
            &quality,
            SinglePassAudioMode::EncodeAac,
            None,
            None,
            None,
        );
        assert!(args.contains(&"-filter_complex".into()));
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        assert!(fc.contains("concat=n=3:v=1:a=0[v]"));
        assert!(fc.contains("concat=n=3:v=0:a=1[a]"));
        assert!(fc.contains("trim=duration=5"));
        assert!(fc.contains("trim=duration=4"));
        assert!(fc.contains("drawtext=text='Gast'"));
        // Outro branch must not get drawtext (only Intro).
        let outro_branch = fc.split("[outrov]").next().unwrap_or("");
        assert!(
            !outro_branch.contains("drawtext") || fc.matches("drawtext").count() == 1,
            "drawtext only on intro"
        );
        assert!(args.contains(&"-loop".into()));
        // Two loops: intro still + outro photo.
        assert_eq!(args.iter().filter(|a| *a == "-loop").count(), 2);
        assert!(args.iter().any(|a| a.starts_with("anullsrc=")));
        assert!(args.iter().any(|a| a.contains("force_key_frames")));
        assert_eq!(args.last().unwrap(), r"C:\out\final.mp4");
    }

    #[test]
    fn intro_body_outro_single_pass_video_only_audio_copy() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let outro = SinglePassOutroInput {
            path: "outro.png".into(),
            kind: OutroKind::Photo,
            dauer: 3.0,
            has_audio: false,
        };
        let args = build_intro_body_outro_single_pass_args(
            None,
            "body.mp4",
            10.0,
            &outro,
            "v.mp4",
            &v,
            "libx264",
            &quality,
            SinglePassAudioMode::VideoOnly,
            None,
            None,
            None,
        );
        assert!(args.contains(&"-an".into()));
        assert!(!args.iter().any(|a| a.starts_with("anullsrc=")));
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .unwrap();
        assert!(fc.contains("concat=n=2:v=1:a=0[v]"));
        assert!(!fc.contains(":a=1[a]"));
    }

    #[test]
    fn intro_body_outro_single_pass_video_outro_keeps_audio() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let outro = SinglePassOutroInput {
            path: "outro.mp4".into(),
            kind: OutroKind::Video,
            dauer: 8.0,
            has_audio: true,
        };
        let args = build_intro_body_outro_single_pass_args(
            Some(("bg.png", "drawtext=text='x'", 5.0)),
            "body.mp4",
            20.0,
            &outro,
            "final.mp4",
            &v,
            "libx264",
            &quality,
            SinglePassAudioMode::EncodeAac,
            None,
            None,
            None,
        );
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .unwrap();
        assert!(fc.contains("concat=n=3:v=1:a=0[v]"));
        // Outro audio from the video input (index 2 when intro present).
        assert!(fc.contains("[2:a]"));
        assert!(fc.contains("[outroa]"));
        // Only one silence pad (intro); no asplit needed.
        assert!(!fc.contains("asplit"));
        // Outro video is not looped.
        assert_eq!(args.iter().filter(|a| *a == "-loop").count(), 1);
        assert!(args.iter().any(|a| a.contains("gte(t,5)") && a.contains("gte(t,25)")));
    }

    #[test]
    fn outro_photo_segment_args_structure() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let args = build_outro_photo_segment_args(
            r"C:\assets\outro.png",
            r"C:\out\outro.mp4",
            6.0,
            &v,
            "libx264",
            &quality,
        );
        assert!(args.contains(&"-loop".into()));
        assert!(args.iter().any(|a| a.starts_with("anullsrc=")));
        // No drawtext on the outro (stays un-personalized).
        let vf = args
            .iter()
            .position(|a| a == "-vf")
            .and_then(|i| args.get(i + 1))
            .expect("-vf");
        assert!(!vf.contains("drawtext"));
        assert!(args.iter().any(|a| a == "6" || a.starts_with("6.")));
        assert_eq!(args.last().unwrap(), r"C:\out\outro.mp4");
    }

    #[test]
    fn outro_video_segment_args_audio_modes() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);

        let with_audio = build_outro_video_segment_args(
            "outro.mp4", "seg.mp4", &v, "libx264", &quality, true,
        );
        assert!(with_audio.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0"));
        assert!(!with_audio.iter().any(|a| a.starts_with("anullsrc=")));

        let no_audio = build_outro_video_segment_args(
            "outro.mp4", "seg.mp4", &v, "libx264", &quality, false,
        );
        assert!(no_audio.iter().any(|a| a.starts_with("anullsrc=")));
        assert!(no_audio.windows(2).any(|w| w[0] == "-map" && w[1] == "1:a:0"));
        assert!(no_audio.contains(&"-shortest".into()));
    }

    #[test]
    fn concat_segments_encode_all_audio_no_silence_input() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = vec!["-preset".into(), "superfast".into(), "-crf".into(), "18".into()];
        let segs = vec![
            ConcatSegment { path: "intro.mp4".into(), has_audio: true, duration: 5.0 },
            ConcatSegment { path: "body.mp4".into(), has_audio: true, duration: 60.0 },
            ConcatSegment { path: "outro.mp4".into(), has_audio: true, duration: 6.0 },
        ];
        let args = build_concat_segments_encode_args(&segs, "final.mp4", &v, "libx264", &quality);
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        assert!(fc.contains("concat=n=3:v=1:a=0[v]"));
        assert!(fc.contains("concat=n=3:v=0:a=1[a]"));
        assert!(!fc.contains("asplit"));
        assert!(!fc.contains("atrim"));
        // No silence lavfi input when every segment has audio.
        assert!(!args.iter().any(|a| a.starts_with("anullsrc=")));
        assert_eq!(args.last().unwrap(), "final.mp4");
    }

    #[test]
    fn concat_segments_encode_silent_body_gets_silence() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = vec!["-crf".into(), "18".into()];
        let segs = vec![
            ConcatSegment { path: "body.mp4".into(), has_audio: false, duration: 30.0 },
            ConcatSegment { path: "outro.mp4".into(), has_audio: true, duration: 4.0 },
        ];
        let args = build_concat_segments_encode_args(&segs, "final.mp4", &v, "libx264", &quality);
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        // Exactly one silent segment → single asplit fan-out + atrim span.
        assert!(fc.contains("asplit=1[sil0]"));
        assert!(fc.contains("[sil0]atrim=0:30"));
        assert!(fc.contains("concat=n=2:v=1:a=0[v]"));
        assert!(fc.contains("concat=n=2:v=0:a=1[a]"));
        assert!(args.iter().any(|a| a.starts_with("anullsrc=")));
    }

    // ----- OPT-21A: skip redundant CapCut normalize filters + conditional hwaccel -----

    #[test]
    fn capcut_normalize_plan_match_vs_mismatch() {
        let target = IntroVideoParams::for_1080p30("h264");
        let match_src = CapcutSourceVideo {
            width: 1920,
            height: 1080,
            fps: "30".into(),
            pix_fmt: "yuv420p".into(),
        };
        let plan = capcut_normalize_plan(Some(&match_src), &target, "yuv420p");
        assert_eq!(plan, CapcutNormalizePlan::none());
        assert!(plan.allow_hwaccel_decode());

        let mismatch_res = CapcutSourceVideo {
            width: 1280,
            height: 720,
            fps: "30".into(),
            pix_fmt: "yuv420p".into(),
        };
        let plan = capcut_normalize_plan(Some(&mismatch_res), &target, "yuv420p");
        assert!(plan.scale_pad);
        assert!(!plan.fps);
        assert!(!plan.format);
        assert!(!plan.allow_hwaccel_decode());

        let mismatch_fmt = CapcutSourceVideo {
            width: 1920,
            height: 1080,
            fps: "30".into(),
            pix_fmt: "yuv420p10le".into(),
        };
        let plan = capcut_normalize_plan(Some(&mismatch_fmt), &target, "yuv420p");
        assert!(!plan.scale_pad);
        assert!(!plan.fps);
        assert!(plan.format);
        assert!(!plan.allow_hwaccel_decode());

        assert_eq!(
            capcut_normalize_plan(None, &target, "yuv420p"),
            CapcutNormalizePlan::full()
        );
        // yuvj420p accepted as CapCut-equivalent to yuv420p.
        let full_range = CapcutSourceVideo {
            width: 1920,
            height: 1080,
            fps: "30/1".into(),
            pix_fmt: "yuvj420p".into(),
        };
        assert_eq!(
            capcut_normalize_plan(Some(&full_range), &target, "yuv420p"),
            CapcutNormalizePlan::none()
        );
    }

    #[test]
    fn capcut_hwaccel_only_when_normalize_fully_skipped() {
        let hw = HwAccelInfo::nvidia();
        assert_eq!(
            capcut_hwaccel_for_decode(&hw, CapcutNormalizePlan::none()),
            Some("cuda")
        );
        assert_eq!(
            capcut_hwaccel_for_decode(&hw, CapcutNormalizePlan::full()),
            None
        );
        let vt = HwAccelInfo::videotoolbox();
        assert_eq!(
            capcut_hwaccel_for_decode(&vt, CapcutNormalizePlan::none()),
            Some("videotoolbox")
        );
        assert_eq!(
            capcut_hwaccel_for_decode(&HwAccelInfo::software(), CapcutNormalizePlan::none()),
            None
        );
    }

    #[test]
    fn single_pass_skips_body_normalize_on_match_and_allows_hwaccel() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let src = CapcutSourceVideo::from_intro_params(&v);
        let args = build_intro_body_single_pass_args(
            "bg.png",
            "body.mp4",
            "out.mp4",
            5.0,
            10.0,
            &v,
            "drawtext=text='x'",
            "h264_nvenc",
            &quality,
            SinglePassAudioMode::VideoOnly,
            Some(&src),
            Some("cuda"),
        );
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        // Body branch: no scale/pad/fps/format — only setpts/setsar.
        assert!(
            fc.contains("[1:v]setpts=PTS-STARTPTS,setsar=1[bodyv]"),
            "body filter={fc}"
        );
        assert!(!fc.contains("[1:v]scale="));
        // Intro still always normalized.
        assert!(fc.contains("[0:v]scale=1920:1080"));
        // hwaccel before body -i (after intro loop -i).
        let hw_i = args.iter().position(|a| a == "-hwaccel").expect("hwaccel");
        assert_eq!(args.get(hw_i + 1).map(String::as_str), Some("cuda"));
        assert_eq!(args.get(hw_i + 2).map(String::as_str), Some("-i"));
        assert_eq!(args.get(hw_i + 3).map(String::as_str), Some("body.mp4"));
    }

    #[test]
    fn single_pass_keeps_body_normalize_on_mismatch_and_strips_hwaccel() {
        let v = IntroVideoParams::for_1080p30("h264");
        let quality = intro_quality_params("libx264", 18, false);
        let src = CapcutSourceVideo {
            width: 1280,
            height: 720,
            fps: "60".into(),
            pix_fmt: "yuv420p10le".into(),
        };
        let args = build_intro_body_single_pass_args(
            "bg.png",
            "body.mp4",
            "out.mp4",
            5.0,
            10.0,
            &v,
            "drawtext=text='x'",
            "h264_nvenc",
            &quality,
            SinglePassAudioMode::EncodeAac,
            Some(&src),
            Some("cuda"), // must be ignored — CPU normalize remains
        );
        let fc = args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| args.get(i + 1))
            .expect("filter_complex");
        assert!(fc.contains("[1:v]scale=1920:1080"));
        assert!(fc.contains("fps=30"));
        assert!(fc.contains("format=yuv420p"));
        assert!(!args.iter().any(|a| a == "-hwaccel"));
    }

    #[test]
    fn build_capcut_segment_vfilter_match_vs_mismatch() {
        let match_plan = CapcutNormalizePlan::none();
        let s = build_capcut_segment_vfilter(1, "bodyv", match_plan, 1920, 1080, "30", "yuv420p", &[]);
        assert_eq!(s, "[1:v]setpts=PTS-STARTPTS,setsar=1[bodyv]");

        let full = CapcutNormalizePlan::full();
        let s = build_capcut_segment_vfilter(0, "v0", full, 1920, 1080, "30", "yuv420p", &[]);
        assert!(s.starts_with("[0:v]scale=1920:1080"));
        assert!(s.contains("pad=1920:1080"));
        assert!(s.contains("fps=30"));
        assert!(s.contains("format=yuv420p"));
        assert!(s.ends_with("[v0]"));
    }
}
