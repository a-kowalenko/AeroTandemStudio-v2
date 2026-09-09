//! Extract full-resolution JPEG frames from a working video clip (Phase 44).
//!
//! - **Accurate** seek (`-ss` after `-i`): playhead / single frame
//! - **Fast** seek (`-ss` before `-i`, accurate fallback): interval batches
//!
//! FFmpeg children go through [`run_ffmpeg_checked`] so Cancel kills in-flight seeks.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;

use crate::storage::app_config_dir;
use crate::util::file_times::get_mtime_timestamp;
use crate::video::ffmpeg::{
    find_ffmpeg, is_cancelled, run_ffmpeg_checked, FfmpegError, WORKFLOW_CANCELLED,
};

/// High-quality JPEG (FFmpeg scale 2–31, lower = better).
const JPEG_QSCALE: &str = "2";

static EXTRACT_SEQ: OnceLock<AtomicUsize> = OnceLock::new();

fn next_extract_id() -> usize {
    EXTRACT_SEQ
        .get_or_init(|| AtomicUsize::new(1))
        .fetch_add(1, Ordering::Relaxed)
}

fn extract_worker_count(job_count: usize) -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    cores.clamp(2, 8).min(job_count.max(1))
}

#[derive(Debug, Error)]
pub enum FrameExtractError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    Cancelled(String),
}

impl FrameExtractError {
    pub fn cancelled() -> Self {
        Self::Cancelled(WORKFLOW_CANCELLED.into())
    }
}

impl From<FfmpegError> for FrameExtractError {
    fn from(e: FfmpegError) -> Self {
        match e {
            FfmpegError::Cancelled => Self::cancelled(),
            other => Self::Message(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSeekMode {
    /// Decode-accurate: `-ss` after `-i` (playhead / single).
    Accurate,
    /// Keyframe-fast: `-ss` before `-i` (interval batches).
    Fast,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractedFrame {
    pub path: String,
    pub time_secs: f64,
}

/// Build FFmpeg argv for one full-resolution JPEG (no `-nostdin`; runner adds it).
pub fn build_extract_frame_args(
    input: &str,
    seek_secs: f64,
    output: &str,
    mode: FrameSeekMode,
) -> Vec<String> {
    let seek = format_seek_secs(seek_secs);
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    match mode {
        FrameSeekMode::Fast => {
            args.push("-ss".into());
            args.push(seek);
            args.push("-i".into());
            args.push(input.to_string());
        }
        FrameSeekMode::Accurate => {
            args.push("-i".into());
            args.push(input.to_string());
            args.push("-ss".into());
            args.push(seek);
        }
    }
    args.extend([
        "-an".into(),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        JPEG_QSCALE.into(),
        "-update".into(),
        "1".into(),
        output.to_string(),
    ]);
    args
}

pub fn format_seek_secs(seek_secs: f64) -> String {
    format!("{:.6}", seek_secs.max(0.0))
}

/// Timestamps for interval mode: `start`, `start+interval`, … while `t <= end`.
pub fn interval_timestamps(start_secs: f64, end_secs: f64, interval_secs: f64) -> Vec<f64> {
    let start = start_secs.max(0.0);
    let end = end_secs.max(start);
    if !(interval_secs > 0.0) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut t = start;
    let max_samples = ((end - start) / interval_secs).floor() as usize + 3;
    while t <= end + 1e-9 && out.len() < max_samples {
        out.push(t.min(end));
        t += interval_secs;
    }
    out
}

pub fn clip_capture_epoch(video_path: &Path) -> f64 {
    get_mtime_timestamp(video_path).unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    })
}

pub fn frame_capture_epoch(clip_base_epoch: f64, offset_secs: f64) -> f64 {
    clip_base_epoch + offset_secs.max(0.0)
}

pub fn set_file_mtime_epoch(path: &Path, epoch: f64) -> std::io::Result<()> {
    let secs = epoch.floor().max(0.0) as u64;
    let nanos = ((epoch.fract() * 1_000_000_000.0).round() as u32).min(999_999_999);
    let st = UNIX_EPOCH + Duration::new(secs, nanos);
    let file = fs::File::options().write(true).open(path)?;
    file.set_modified(st)
}

fn extract_work_dir() -> Result<PathBuf, FrameExtractError> {
    let dir = app_config_dir()
        .map_err(|e| FrameExtractError::Message(e.to_string()))?
        .join("frame_extract");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn run_extract_one(
    ffmpeg: &Path,
    input: &str,
    seek_secs: f64,
    out_path: &Path,
    mode: FrameSeekMode,
) -> Result<(), FrameExtractError> {
    if is_cancelled() {
        return Err(FrameExtractError::cancelled());
    }
    let out_str = out_path.to_string_lossy().into_owned();
    let args = build_extract_frame_args(input, seek_secs, &out_str, mode);
    match run_ffmpeg_checked(ffmpeg, &args) {
        Ok(()) => {}
        Err(e) => {
            let _ = fs::remove_file(out_path);
            if is_cancelled() || matches!(e, FfmpegError::Cancelled) {
                return Err(FrameExtractError::cancelled());
            }
            if mode == FrameSeekMode::Fast {
                // Accurate fallback when keyframe seek fails.
                let accurate = build_extract_frame_args(
                    input,
                    seek_secs,
                    &out_str,
                    FrameSeekMode::Accurate,
                );
                match run_ffmpeg_checked(ffmpeg, &accurate) {
                    Ok(()) => {}
                    Err(e2) => {
                        let _ = fs::remove_file(out_path);
                        if is_cancelled() || matches!(e2, FfmpegError::Cancelled) {
                            return Err(FrameExtractError::cancelled());
                        }
                        return Err(FrameExtractError::Message(format!(
                            "FFmpeg frame extract failed ({input} @ {seek_secs:.3}): {e2}"
                        )));
                    }
                }
            } else {
                return Err(FrameExtractError::Message(format!(
                    "FFmpeg frame extract failed ({input} @ {seek_secs:.3}): {e}"
                )));
            }
        }
    }
    let meta = fs::metadata(out_path).map_err(|_| {
        FrameExtractError::Message("FFmpeg finished but frame file is missing".into())
    })?;
    if meta.len() == 0 {
        let _ = fs::remove_file(out_path);
        return Err(FrameExtractError::Message(
            "FFmpeg wrote an empty frame file".into(),
        ));
    }
    Ok(())
}

/// Extract frames at the given timestamps into a unique temp folder.
///
/// Sets each JPEG mtime to `clip_base + time` for Chrono import naming.
/// `on_progress(done_1based, total, time_secs)` after each successful frame.
pub fn extract_frames_at_times<F>(
    video_path: &Path,
    times_secs: &[f64],
    ffmpeg: Option<&Path>,
    seek_mode: FrameSeekMode,
    mut on_progress: F,
) -> Result<Vec<ExtractedFrame>, FrameExtractError>
where
    F: FnMut(u64, u64, f64) + Send,
{
    if times_secs.is_empty() {
        return Ok(Vec::new());
    }
    if is_cancelled() {
        return Err(FrameExtractError::cancelled());
    }
    if !video_path.is_file() {
        return Err(FrameExtractError::Message(format!(
            "input file not found: {}",
            video_path.display()
        )));
    }

    let ffmpeg_owned;
    let ffmpeg = match ffmpeg {
        Some(p) => p,
        None => {
            ffmpeg_owned = find_ffmpeg().map_err(|e| FrameExtractError::Message(e.to_string()))?;
            &ffmpeg_owned
        }
    };

    let batch_dir = extract_work_dir()?.join(format!("batch_{}", next_extract_id()));
    fs::create_dir_all(&batch_dir)?;

    let clip_base = clip_capture_epoch(video_path);
    let in_str = video_path.to_string_lossy().into_owned();
    let total = times_secs.len() as u64;
    let count = times_secs.len();

    let out_paths: Vec<PathBuf> = (0..count)
        .map(|i| batch_dir.join(format!("frame_{i:05}.jpg")))
        .collect();

    let next = AtomicUsize::new(0);
    let done_count = AtomicUsize::new(0);
    let error: Mutex<Option<FrameExtractError>> = Mutex::new(None);
    let on_progress = Mutex::new(on_progress);
    let workers = extract_worker_count(count);

    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if is_cancelled() {
                        if let Ok(mut g) = error.lock() {
                            if g.is_none() {
                                *g = Some(FrameExtractError::cancelled());
                            }
                        }
                        break;
                    }
                    if error
                        .lock()
                        .ok()
                        .and_then(|g| g.is_some().then_some(()))
                        .is_some()
                    {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= count {
                        break;
                    }
                    let t = times_secs[i];
                    let out = &out_paths[i];
                    match run_extract_one(ffmpeg, &in_str, t, out, seek_mode) {
                        Ok(()) => {
                            let epoch = frame_capture_epoch(clip_base, t);
                            let _ = set_file_mtime_epoch(out, epoch);
                            let finished = done_count.fetch_add(1, Ordering::SeqCst) + 1;
                            if let Ok(mut cb) = on_progress.lock() {
                                cb(finished as u64, total, t);
                            }
                        }
                        Err(e) => {
                            let cancelled = matches!(e, FrameExtractError::Cancelled(_))
                                || is_cancelled();
                            if let Ok(mut g) = error.lock() {
                                if g.is_none() {
                                    *g = Some(if cancelled {
                                        FrameExtractError::cancelled()
                                    } else {
                                        e
                                    });
                                }
                            }
                            break;
                        }
                    }
                }
            });
        }
    });

    if let Ok(g) = error.lock() {
        if let Some(err) = g.as_ref() {
            let _ = fs::remove_dir_all(&batch_dir);
            return Err(match err {
                FrameExtractError::Cancelled(s) => FrameExtractError::Cancelled(s.clone()),
                FrameExtractError::Message(s) => FrameExtractError::Message(s.clone()),
                FrameExtractError::Io(e) => FrameExtractError::Message(e.to_string()),
            });
        }
    }

    let mut frames = Vec::with_capacity(count);
    for (i, path) in out_paths.into_iter().enumerate() {
        frames.push(ExtractedFrame {
            path: path.to_string_lossy().into_owned(),
            time_secs: times_secs[i],
        });
    }
    Ok(frames)
}

/// Extract a single frame at `time_secs` (decode-accurate).
pub fn extract_frame_at(
    video_path: &Path,
    time_secs: f64,
    ffmpeg: Option<&Path>,
) -> Result<ExtractedFrame, FrameExtractError> {
    let frames = extract_frames_at_times(
        video_path,
        &[time_secs.max(0.0)],
        ffmpeg,
        FrameSeekMode::Accurate,
        |_, _, _| {},
    )?;
    frames
        .into_iter()
        .next()
        .ok_or_else(|| FrameExtractError::Message("no frame extracted".into()))
}

/// Copy files into `dest_dir`, preserving basenames (unique-ify on collision).
pub fn copy_files_preserving_names(
    paths: &[String],
    dest_dir: &Path,
) -> Result<Vec<String>, FrameExtractError> {
    fs::create_dir_all(dest_dir)?;
    let mut written = Vec::new();
    for src in paths {
        if is_cancelled() {
            return Err(FrameExtractError::cancelled());
        }
        let src_path = Path::new(src);
        if !src_path.is_file() {
            return Err(FrameExtractError::Message(format!(
                "file not found: {src}"
            )));
        }
        let name = src_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "foto.jpg".into());
        let mut dest = dest_dir.join(&name);
        if dest.exists() {
            let stem = dest
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "foto".into());
            let ext = dest
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut n = 2u32;
            loop {
                let candidate = dest_dir.join(format!("{stem}_{n}{ext}"));
                if !candidate.exists() {
                    dest = candidate;
                    break;
                }
                n += 1;
                if n > 10_000 {
                    return Err(FrameExtractError::Message(
                        "could not find unique export name".into(),
                    ));
                }
            }
        }
        fs::copy(src_path, &dest)?;
        written.push(dest.to_string_lossy().into_owned());
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::ffmpeg::find_ffmpeg;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    #[test]
    fn build_extract_frame_args_accurate_seek_order() {
        let args =
            build_extract_frame_args(r"C:\clip.mp4", 12.5, r"C:\out.jpg", FrameSeekMode::Accurate);
        let i_pos = args.iter().position(|a| a == "-i").expect("-i");
        let ss_pos = args.iter().position(|a| a == "-ss").expect("-ss");
        assert!(
            ss_pos > i_pos,
            "accurate seek: -ss must follow -i (got {args:?})"
        );
        assert_eq!(args[ss_pos + 1], "12.500000");
        assert!(args.iter().any(|a| a == "-frames:v"));
        assert_eq!(args.last().map(String::as_str), Some(r"C:\out.jpg"));
    }

    #[test]
    fn build_extract_frame_args_fast_seek_order() {
        let args =
            build_extract_frame_args(r"C:\clip.mp4", 3.0, r"C:\out.jpg", FrameSeekMode::Fast);
        let i_pos = args.iter().position(|a| a == "-i").expect("-i");
        let ss_pos = args.iter().position(|a| a == "-ss").expect("-ss");
        assert!(
            ss_pos < i_pos,
            "fast seek: -ss must precede -i (got {args:?})"
        );
    }

    #[test]
    fn interval_timestamps_half_second() {
        let times = interval_timestamps(0.0, 2.0, 0.5);
        assert_eq!(times, vec![0.0, 0.5, 1.0, 1.5, 2.0]);
    }

    #[test]
    fn interval_timestamps_trim_range() {
        let times = interval_timestamps(1.0, 2.0, 0.5);
        assert_eq!(times, vec![1.0, 1.5, 2.0]);
    }

    #[test]
    fn interval_timestamps_rejects_bad_interval() {
        assert!(interval_timestamps(0.0, 5.0, 0.0).is_empty());
        assert!(interval_timestamps(0.0, 5.0, -1.0).is_empty());
    }

    #[test]
    fn frame_capture_epoch_adds_offset() {
        let base = 1_700_000_000.0;
        assert!((frame_capture_epoch(base, 1.5) - (base + 1.5)).abs() < 1e-9);
        assert!((frame_capture_epoch(base, -2.0) - base).abs() < 1e-9);
    }

    #[test]
    fn extract_worker_count_clamped() {
        assert_eq!(extract_worker_count(1), 1);
        assert!(extract_worker_count(100) >= 2);
        assert!(extract_worker_count(100) <= 8);
    }

    #[test]
    fn extract_frames_from_generated_mp4() {
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
                "color=c=green:s=320x240:d=2",
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

        crate::video::ffmpeg::reset_cancel_flag();
        let frames = extract_frames_at_times(
            &vid,
            &[0.0, 0.5, 1.0],
            Some(&ffmpeg),
            FrameSeekMode::Fast,
            |_, _, _| {},
        )
        .expect("extract");
        assert_eq!(frames.len(), 3);
        for f in &frames {
            let p = Path::new(&f.path);
            assert!(p.is_file(), "missing {}", f.path);
            assert!(fs::metadata(p).unwrap().len() > 32);
        }
    }
}
