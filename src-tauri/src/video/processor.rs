//! Intro pipeline & final video creation (behaviour port of legacy `processor.py`).
//!
//! Phase 3: Hintergrund-PNG + drawtext overlay → Intro, body concat, mux.
//! Phase 4: Multi-clip body concat prep runs in parallel; progress may include `task_id`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

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
use super::concat::{self, ConcatError, VideoCodec};
use super::encoding_quality::{
    build_encode_output_params, resolve_output_codec, VideoCodecPreference,
};
use super::ffmpeg::{
    disk_full_error, ffmpeg_probe_stderr, is_cancelled, is_disk_full_error, probe_duration_secs,
    run_ffmpeg, run_ffmpeg_checked, run_ffmpeg_tagged, FfmpegError, ProgressCallback,
};
use super::hw_accel::{detect_hardware, HwAccelInfo};
use super::intro_mux_fallback::IntroMuxChoice;
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::probe;
use super::progress::{progress_from_times, progress_from_times_with_task};

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
    /// Use NVENC/VideoToolbox when available (from config `hardware_acceleration_enabled`).
    #[serde(default)]
    pub hw_accel_enabled: bool,
}

fn default_intro_dauer() -> f64 {
    DEFAULT_INTRO_DAUER_SECS
}
fn default_true() -> bool {
    true
}
fn default_crf() -> u8 {
    18
}
fn default_intro_mux_mode() -> String {
    "reencode".into()
}

fn is_stream_copy_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "stream_copy" | "stream-copy" | "streamcopy"
    )
}

impl Default for CreateVideoOptions {
    fn default() -> Self {
        Self {
            dauer: DEFAULT_INTRO_DAUER_SECS,
            intro_enabled: true,
            video_codec: VideoCodecPreference::Auto,
            crf: 18,
            parallel_enabled: true,
            intro_mux_mode: default_intro_mux_mode(),
            hw_accel_enabled: false,
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

    let intro_v = format!(
        "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
         {drawtext_filter},format={target_pix_fmt},fps={fps},\
         trim=duration={intro_dauer},setpts=PTS-STARTPTS,setsar=1[introv]"
    );
    let body_v = format!(
        "[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps},format={target_pix_fmt},\
         setpts=PTS-STARTPTS,setsar=1[bodyv]"
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
        "-i".into(),
        body_path.to_string(),
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
    ];

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
    let mut first: Option<VideoCodec> = None;
    for p in paths {
        let Ok(stderr) = ffmpeg_probe_stderr(ffmpeg, p) else {
            return false;
        };
        let meta = probe::parse_video_metadata_from_probe(&stderr);
        let codec = meta
            .as_ref()
            .map(|m| concat::normalize_vcodec_name(&m.codec))
            .unwrap_or(VideoCodec::Other);
        if matches!(codec, VideoCodec::Other) {
            return false;
        }
        match first {
            None => first = Some(codec),
            Some(prev) if prev != codec => return false,
            _ => {}
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Create final MP4: optional intro + body clips → `output`.
///
/// Default mux: continuous re-encode of intro+body (customer-compatible).
/// Optional `stream_copy`: when it fails and `on_intro_mux_fallback` is set, the
/// callback decides between body-only export and re-encode-with-intro.
/// When unset (e.g. preview), stream-copy failure falls back to re-encode.
pub fn create_video(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    output: &str,
    options: &CreateVideoOptions,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
    on_intro_mux_fallback: Option<IntroMuxAskFn>,
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

    let stages = if options.intro_enabled { 4.0 } else { 3.0 };
    let work = work_temp_dir(output)?;
    let mut encoder_used = String::from("libx264");
    let hw = detect_hardware();
    let hw_accel_enabled = options.hw_accel_enabled;

    // Stage 1: body (single path, parallel per-clip encode, or concat)
    emit_stage(&on_progress, 0.0, stages, "Bereite Videoclips vor…");
    let body_path = if video_paths.len() == 1 {
        video_paths[0].clone()
    } else if options.parallel_enabled && !body_codecs_compatible(ffmpeg, video_paths) {
        // Mixed codecs → per_clip encode in parallel, then stream-copy concat
        let pool = ParallelVideoProcessor::new(hw_accel_enabled && hw.available);
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
        let body_codec_name = probe::parse_video_metadata_from_probe(&probe0)
            .map(|m| m.codec)
            .unwrap_or_else(|| "h264".into());
        let out_codec = resolve_output_codec(options.video_codec, &body_codec_name);
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
            options.crf,
            hw_accel_enabled,
            Arc::clone(&on_progress),
        )?;

        let body_out = work.join("body_concat.mp4");
        let body_out_s = body_out.to_string_lossy().to_string();
        let cb = Arc::clone(&on_progress);
        on_progress(progress_from_times(5.0, 100.0, "Füge kodierte Clips zusammen…"));
        concat::concat_videos_with_opts(
            ffmpeg,
            &clip_outs,
            &body_out_s,
            cb,
            hw_accel_enabled,
            options.crf,
        )?;
        encoder_used = v_params.vcodec.clone();
        body_out_s
    } else {
        if options.parallel_enabled {
            let pool = ParallelVideoProcessor::new(hw_accel_enabled && hw.available);
            on_progress(progress_from_times_with_task(
                0.0,
                100.0,
                &format!(
                    "Füge {} Clips zusammen ({} Worker)…",
                    video_paths.len(),
                    pool.max_workers,
                ),
                None,
            ));
        }
        let body_out = work.join("body_concat.mp4");
        let body_out_s = body_out.to_string_lossy().to_string();
        let cb = Arc::clone(&on_progress);
        concat::concat_videos_with_opts(
            ffmpeg,
            video_paths,
            &body_out_s,
            cb,
            hw_accel_enabled,
            options.crf,
        )?;
        body_out_s
    };
    emit_stage(&on_progress, 1.0, stages, "Videoclips vorbereitet");

    let body_stderr = ffmpeg_probe_stderr(ffmpeg, &body_path)?;
    let body_meta = probe::parse_video_metadata_from_probe(&body_stderr);
    let body_codec_name = body_meta
        .as_ref()
        .map(|m| m.codec.as_str())
        .unwrap_or("h264");
    let out_codec = resolve_output_codec(options.video_codec, body_codec_name);
    let mut v_params = intro_params_from_probe(&body_stderr, body_codec_name);
    v_params.vcodec = match out_codec {
        VideoCodec::Hevc => "hevc".into(),
        _ => "h264".into(),
    };

    let final_body = if options.intro_enabled {
        let hintergrund = find_asset(ASSET_HINTERGRUND, resource_dir)?;
        let hintergrund_s = hintergrund.to_string_lossy().to_string();
        let drawtext = prepare_text_overlay(kunde, v_params.width, v_params.height);
        let intro_path = work.join("intro.mp4");
        let intro_s = intro_path.to_string_lossy().to_string();
        let use_stream_copy = is_stream_copy_mode(&options.intro_mux_mode);

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
                        55.0,
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
                    // Preview / silent path: keep previous auto re-encode behaviour.
                    IntroMuxChoice::WithIntroEncode
                };

                match choice {
                    IntroMuxChoice::WithoutIntro => {
                        on_progress(progress_from_times(
                            60.0,
                            100.0,
                            "Exportiere Video ohne Intro (Stream-Copy)…",
                        ));
                        let enc = export_body_to_output(
                            ffmpeg,
                            &body_path,
                            output,
                            &hw,
                            out_codec,
                            options.crf,
                            hw_accel_enabled,
                            Arc::clone(&on_progress),
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
                        on_progress(progress_from_times(
                            60.0,
                            100.0,
                            &format!("Kodiere Intro+Video neu: {reason}"),
                        ));
                        mux_intro_body_single_pass(
                            ffmpeg,
                            &hintergrund_s,
                            &body_path,
                            output,
                            options.dauer,
                            &v_params,
                            &drawtext,
                            &hw,
                            options.crf,
                            hw_accel_enabled,
                            &work,
                            Arc::clone(&mux_cb),
                        )
                    }
                }
            };

        let mux_result = if use_stream_copy {
            // Optional fast path: intro clip + stream-copy concat (may fail on cameras).
            emit_stage(&on_progress, 1.0, stages, "Erstelle Intro…");
            let intro_cb = {
                let outer = Arc::clone(&on_progress);
                Arc::new(move |p: crate::video::progress::EncodeProgress| {
                    let mut q = p;
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
            emit_stage(&on_progress, 2.0, stages, "Intro fertig");

            emit_stage(&on_progress, 2.0, stages, "Füge Intro und Video zusammen…");
            let paths = vec![intro_s.clone(), body_path.clone()];
            match concat::concat_videos_stream_copy_only(
                ffmpeg,
                &paths,
                output,
                Arc::clone(&mux_cb),
            ) {
                Ok(outcome) => Ok(outcome),
                Err(ConcatError::NeedsReencode { reason }) => {
                    handle_needs_reencode(reason)
                }
                Err(e) => Err(e),
            }
        } else {
            // Default: one continuous encode (intro overlay + body) — customer-compatible.
            emit_stage(
                &on_progress,
                1.0,
                stages,
                "Kodiere Intro+Video (kompatibel)…",
            );
            mux_intro_body_single_pass(
                ffmpeg,
                &hintergrund_s,
                &body_path,
                output,
                options.dauer,
                &v_params,
                &drawtext,
                &hw,
                options.crf,
                hw_accel_enabled,
                &work,
                Arc::clone(&mux_cb),
            )
        };

        let outcome = mux_result?;
        let intro_created = outcome.method != "body-only";
        encoder_used = outcome.codec;
        emit_stage(&on_progress, 3.0, stages, "Zusammenfügen fertig");

        CreateVideoResult {
            output: output.to_string(),
            encoder: encoder_used,
            intro_created,
            body_clips: video_paths.len(),
        }
    } else {
        // No intro: copy/re-mux body to output
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
                Arc::clone(&on_progress),
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

/// Remux body to `output` via stream-copy; re-encode only if remux fails.
fn export_body_to_output(
    ffmpeg: &Path,
    body_path: &str,
    output: &str,
    hw: &HwAccelInfo,
    out_codec: VideoCodec,
    crf: u8,
    hw_accel_enabled: bool,
    on_progress: ProgressCallback,
) -> Result<String, ProcessorError> {
    let (enc, out_params) =
        build_encode_output_params(hw, out_codec, crf, !hw_accel_enabled);
    let mut encoder_used = enc;
    let mut args = vec![
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
    let dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.0);
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
    if let Err(e) = run_ffmpeg(ffmpeg, &args, dur, Arc::clone(&export_cb)) {
        if is_disk_full_error(&e) {
            return Err(ProcessorError::Ffmpeg(disk_full_error()));
        }
        let reason = format!(
            "Remux (Stream-Copy) fehlgeschlagen → Neu-Kodierung als Fallback ({e})"
        );
        on_progress(progress_from_times(50.0, 100.0, &format!("Kodiere neu: {reason}")));
        let reenc_cb: ProgressCallback = {
            let outer = Arc::clone(&on_progress);
            let reason = reason.clone();
            Arc::new(move |p: crate::video::progress::EncodeProgress| {
                let mut q = p;
                if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                    q.status = format!("Kodiere neu: {reason}");
                }
                outer(q);
            })
        };
        args = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-i".into(),
            body_path.to_string(),
        ];
        args.extend(out_params);
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            output.to_string(),
        ]);
        run_ffmpeg(ffmpeg, &args, dur, reenc_cb)?;
    } else {
        encoder_used = "copy".into();
    }
    Ok(encoder_used)
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
    for &force_sw in attempts {
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

/// Single-pass Intro+Body encode (one bitstream). Optionally stream-copies body AAC.
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
    work: &Path,
    on_progress: ProgressCallback,
) -> Result<concat::ConcatOutcome, ConcatError> {
    if is_cancelled() {
        return Err(ConcatError::Ffmpeg(FfmpegError::Cancelled));
    }

    let has_audio = concat::probe_has_audio(ffmpeg, body_path)?;
    let body_dur = probe_duration_secs(ffmpeg, body_path).unwrap_or(0.0).max(0.05);
    let intro_dauer = intro_dauer.max(0.1);
    let total = intro_dauer + body_dur;
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

    on_progress(progress_from_times(
        25.0,
        100.0,
        if copy_audio {
            "Kodiere Intro+Video (Audio-Copy)…"
        } else {
            "Kodiere Intro+Video (kompatibel)…"
        },
    ));

    let codec = match v_params.vcodec.as_str() {
        "hevc" | "h265" => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };

    let mut last_err: Option<ConcatError> = None;
    let attempts: &[bool] = if hw_accel_enabled {
        &[false, true]
    } else {
        &[true]
    };
    let mut encoder_used = String::new();
    let mut encoded = false;
    for &force_sw in attempts {
        let (encoder, out_params) = build_encode_output_params(hw, codec, crf, force_sw);
        let quality = quality_params_without_codec(out_params);
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
        return Err(last_err.unwrap_or_else(|| ConcatError::NeedsReencode {
            reason: "Intro+Body Single-Pass-Kodierung fehlgeschlagen".into(),
        }));
    }

    if copy_audio {
        on_progress(progress_from_times(80.0, 100.0, "Audio anhängen (Copy)…"));
        assemble_silent_plus_body_audio(
            ffmpeg,
            body_path,
            &video_target,
            output,
            intro_dauer,
            v_params,
            work,
        )?;
        let _ = fs::remove_file(&video_target);
    }

    Ok(concat::ConcatOutcome {
        method: if copy_audio {
            "single-pass-reencode+acopy".into()
        } else {
            "single-pass-reencode".into()
        },
        codec: encoder_used,
        reencode_reason: Some("Intro+Body durchgängig kodieren (kundenkompatibel)".into()),
    })
}

fn assemble_silent_plus_body_audio(
    ffmpeg: &Path,
    body_path: &str,
    video_path: &str,
    output: &str,
    intro_dauer: f64,
    v_params: &IntroVideoParams,
    work: &Path,
) -> Result<(), ConcatError> {
    let silent = work.join("intro_silence.m4a");
    let silent_s = silent.to_string_lossy().to_string();
    let body_a = work.join("body_audio.m4a");
    let body_a_s = body_a.to_string_lossy().to_string();
    let full_a = work.join("full_audio.m4a");
    let full_a_s = full_a.to_string_lossy().to_string();

    let silent_args = build_silent_aac_args(
        &silent_s,
        intro_dauer,
        &v_params.sample_rate,
        &v_params.channel_layout,
    );
    run_ffmpeg_checked(ffmpeg, &silent_args).map_err(ConcatError::Ffmpeg)?;

    let extract_args = build_extract_audio_copy_args(body_path, &body_a_s);
    run_ffmpeg_checked(ffmpeg, &extract_args).map_err(ConcatError::Ffmpeg)?;

    let list_path = work.join("audio_concat.txt");
    concat::write_concat_file_list(&[&silent_s, &body_a_s], &list_path)?;
    let concat_args = vec![
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
        full_a_s.clone(),
    ];
    run_ffmpeg_checked(ffmpeg, &concat_args).map_err(ConcatError::Ffmpeg)?;

    let mux_args = build_mux_video_audio_copy_args(video_path, &full_a_s, output);
    run_ffmpeg_checked(ffmpeg, &mux_args).map_err(ConcatError::Ffmpeg)?;
    Ok(())
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
    fn stream_copy_mode_detection() {
        assert!(is_stream_copy_mode("stream_copy"));
        assert!(is_stream_copy_mode("stream-copy"));
        assert!(!is_stream_copy_mode("reencode"));
        assert!(!is_stream_copy_mode("soft_splice"));
        assert!(!is_stream_copy_mode(""));
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
}
