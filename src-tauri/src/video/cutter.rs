//! Video cut / split (behaviour port of legacy `cutter_service.py`).
//!
//! Phase 9 uses stream-copy as the primary strategy (lossless, fast) and reuses
//! `concat::trim_video` for precise re-encode when requested. Smart-cut with
//! partial re-encode at keyframe edges is deferred; stream-copy matches the
//! common DJI workflow where GOPs are short.
//!
//! Player note: libmpv sidecar is deferred — the React UI uses HTML5
//! (`VideoPlayer.tsx`) against `convertFileSrc` until a dedicated mpv plugin
//! lands in a later polish pass.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use super::concat::{self, ConcatError};
use super::ffmpeg::{run_ffmpeg, ProgressCallback};
use super::progress::EncodeProgress;

#[derive(Debug, Error)]
pub enum CutterError {
    #[error(transparent)]
    Concat(#[from] ConcatError),
    #[error(transparent)]
    Ffmpeg(#[from] super::ffmpeg::FfmpegError),
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct CutResult {
    pub output: String,
    pub method: String,
    pub overwritten: bool,
    pub reencode_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitResult {
    pub part1_path: String,
    pub part2_path: String,
    pub method: String,
    pub overwritten: bool,
}

fn format_secs(secs: f64) -> String {
    format!("{secs:.6}")
}

fn emit(on_progress: &ProgressCallback, percent: f64, status: &str) {
    on_progress(EncodeProgress {
        percent: percent.clamp(0.0, 100.0),
        current_secs: 0.0,
        total_secs: 0.0,
        status: status.to_string(),
        task_id: None,
    });
}

fn map_av(has_audio: bool, args: &mut Vec<String>) {
    args.extend(["-map".into(), "0:v:0?".into()]);
    if has_audio {
        args.extend(["-map".into(), "0:a:0?".into()]);
    }
}

/// Stream-copy cut: keep `[start, start+duration)` (legacy `_trim_stream_copy`).
pub fn build_cut_stream_copy_args(
    input: &str,
    output: &str,
    start_secs: f64,
    duration_secs: f64,
    has_audio: bool,
) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-ss".into(),
        format_secs(start_secs),
        "-i".into(),
        input.to_string(),
        "-t".into(),
        format_secs(duration_secs),
    ];
    map_av(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Stream-copy first half of a split: `[0, split_secs)`.
pub fn build_split_part1_args(input: &str, output: &str, split_secs: f64, has_audio: bool) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.to_string(),
        "-t".into(),
        format_secs(split_secs),
    ];
    map_av(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Stream-copy second half of a split: from `split_secs` to EOF.
pub fn build_split_part2_args(input: &str, output: &str, split_secs: f64, has_audio: bool) -> Vec<String> {
    let mut args = vec![
        "-y".into(),
        "-ss".into(),
        format_secs(split_secs),
        "-i".into(),
        input.to_string(),
    ];
    map_av(has_audio, &mut args);
    args.extend([
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
}

/// Temp path next to `video_path`: `name.__temp_cut__.ext`.
pub fn temp_cut_path(video_path: &str) -> PathBuf {
    let path = Path::new(video_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    path.with_file_name(format!("{stem}.__temp_cut__.{ext}"))
}

/// Temp path for split part 1 before atomic rename.
pub fn temp_split_part1_path(video_path: &str) -> PathBuf {
    let path = Path::new(video_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    path.with_file_name(format!("{stem}.__temp_part1__.{ext}"))
}

/// Final split paths: `name_1.ext` / `name_2.ext` (legacy `apply_split_overwrite`).
pub fn split_output_paths(video_path: &str) -> (PathBuf, PathBuf) {
    let path = Path::new(video_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    (
        parent.join(format!("{stem}_1.{ext}")),
        parent.join(format!("{stem}_2.{ext}")),
    )
}

fn validate_trim_range(start_secs: f64, end_secs: f64) -> Result<f64, CutterError> {
    if !(start_secs >= 0.0) || !(end_secs > start_secs) {
        return Err(CutterError::Message(
            "cut requires 0 <= start < end".into(),
        ));
    }
    Ok(end_secs - start_secs)
}

/// Cut `[start_secs, end_secs)` to `output` (or overwrite input when `overwrite`).
pub fn cut_video(
    ffmpeg: &Path,
    input: &str,
    start_secs: f64,
    end_secs: f64,
    output: Option<&str>,
    overwrite: bool,
    precise: bool,
    on_progress: ProgressCallback,
) -> Result<CutResult, CutterError> {
    if !Path::new(input).is_file() {
        return Err(CutterError::Message(format!("input file not found: {input}")));
    }
    let duration = validate_trim_range(start_secs, end_secs)?;

    let (target, is_overwrite) = if overwrite {
        (temp_cut_path(input), true)
    } else {
        let out = output
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| CutterError::Message("output path is required when overwrite=false".into()))?;
        (PathBuf::from(out), false)
    };
    let target_str = target.to_string_lossy().to_string();

    let method = if precise {
        // trim_video emits the re-encode reason in its progress status
        concat::trim_video(
            ffmpeg,
            input,
            start_secs,
            end_secs,
            &target_str,
            true,
            on_progress.clone(),
        )?;
        "re-encode".to_string()
    } else {
        emit(&on_progress, 5.0, "stream-copy cut");
        let has_audio = concat::probe_has_audio(ffmpeg, input).unwrap_or(true);
        let args = build_cut_stream_copy_args(input, &target_str, start_secs, duration, has_audio);
        run_ffmpeg(ffmpeg, &args, duration, on_progress.clone())?;
        "stream-copy".to_string()
    };

    let final_output = if is_overwrite {
        emit(&on_progress, 98.0, "replacing original");
        if !target.is_file() {
            return Err(CutterError::Message("temp cut output missing".into()));
        }
        fs::rename(&target, input)?;
        input.to_string()
    } else {
        target_str
    };

    emit(&on_progress, 100.0, "end");
    Ok(CutResult {
        output: final_output,
        method: method.clone(),
        overwritten: is_overwrite,
        reencode_reason: if method == "re-encode" {
            Some(
                "Präziser Zuschnitt (frame-genau) erfordert Neu-Kodierung".into(),
            )
        } else {
            None
        },
    })
}

/// Split at `split_secs` into two files.
///
/// When `overwrite`, mimics legacy: write part1 to temp, part2 to `name_2`, then
/// replace original → `name_1` and keep `name_2`.
pub fn split_video(
    ffmpeg: &Path,
    input: &str,
    split_secs: f64,
    part1_out: Option<&str>,
    part2_out: Option<&str>,
    overwrite: bool,
    on_progress: ProgressCallback,
) -> Result<SplitResult, CutterError> {
    if !Path::new(input).is_file() {
        return Err(CutterError::Message(format!("input file not found: {input}")));
    }
    if !(split_secs > 0.1) {
        return Err(CutterError::Message(
            "split point must be > 0.1 seconds".into(),
        ));
    }

    let has_audio = concat::probe_has_audio(ffmpeg, input).unwrap_or(true);

    let (part1_path, part2_path, is_overwrite) = if overwrite {
        let (_final1, final2) = split_output_paths(input);
        (temp_split_part1_path(input), final2, true)
    } else {
        let p1 = part1_out
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| CutterError::Message("part1_path required when overwrite=false".into()))?;
        let p2 = part2_out
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| CutterError::Message("part2_path required when overwrite=false".into()))?;
        (PathBuf::from(p1), PathBuf::from(p2), false)
    };

    let p1_str = part1_path.to_string_lossy().to_string();
    let p2_str = part2_path.to_string_lossy().to_string();

    emit(&on_progress, 10.0, "split part 1");
    let args1 = build_split_part1_args(input, &p1_str, split_secs, has_audio);
    let on1 = on_progress.clone();
    let wrapped1: ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let scaled = EncodeProgress {
            percent: 10.0 + p.percent * 0.4,
            ..p
        };
        on1(scaled);
    });
    run_ffmpeg(ffmpeg, &args1, split_secs, wrapped1)?;

    emit(&on_progress, 55.0, "split part 2");
    let args2 = build_split_part2_args(input, &p2_str, split_secs, has_audio);
    let on2 = on_progress.clone();
    let wrapped2: ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let scaled = EncodeProgress {
            percent: 55.0 + p.percent * 0.4,
            ..p
        };
        on2(scaled);
    });
    // Duration unknown for part2 — use a generous estimate from split point.
    run_ffmpeg(ffmpeg, &args2, split_secs.max(1.0), wrapped2)?;

    let (final1, final2) = if is_overwrite {
        emit(&on_progress, 95.0, "renaming split outputs");
        let (dest1, dest2) = split_output_paths(input);
        if !part1_path.is_file() || !part2_path.is_file() {
            let _ = fs::remove_file(&part1_path);
            let _ = fs::remove_file(&part2_path);
            return Err(CutterError::Message("split outputs missing".into()));
        }
        // Legacy: replace original with part1 temp, then rename to _1; _2 already written.
        fs::rename(&part1_path, input)?;
        if dest1.exists() {
            let _ = fs::remove_file(&dest1);
        }
        fs::rename(input, &dest1)?;
        // part2 already at dest2 (= part2_path when overwrite)
        let _ = dest2;
        (
            dest1.to_string_lossy().to_string(),
            part2_path.to_string_lossy().to_string(),
        )
    } else {
        (p1_str, p2_str)
    };

    emit(&on_progress, 100.0, "end");
    Ok(SplitResult {
        part1_path: final1,
        part2_path: final2,
        method: "stream-copy".into(),
        overwritten: is_overwrite,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cut_stream_copy_ss_before_i_and_duration() {
        let args = build_cut_stream_copy_args("in.mp4", "out.mp4", 1.25, 4.5, true);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert!(ss < i);
        assert!(i < t);
        assert!(args.contains(&"1.250000".into()));
        assert!(args.contains(&"4.500000".into()));
        assert!(args.contains(&"copy".into()));
        assert!(args.contains(&"0:a:0?".into()));
    }

    #[test]
    fn cut_stream_copy_omits_audio_map_when_no_audio() {
        let args = build_cut_stream_copy_args("in.mp4", "out.mp4", 0.0, 2.0, false);
        assert!(!args.iter().any(|a| a == "0:a:0?"));
        assert!(args.contains(&"0:v:0?".into()));
    }

    #[test]
    fn split_part1_uses_t_not_ss() {
        let args = build_split_part1_args("clip.mp4", "a.mp4", 12.5, true);
        assert!(args.contains(&"-t".into()));
        assert!(args.contains(&"12.500000".into()));
        assert!(!args.iter().any(|a| a == "-ss"));
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], "clip.mp4");
    }

    #[test]
    fn split_part2_ss_before_i() {
        let args = build_split_part2_args("clip.mp4", "b.mp4", 12.5, false);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i);
        assert!(args.contains(&"12.500000".into()));
        assert!(!args.iter().any(|a| a == "0:a:0?"));
    }

    #[test]
    fn temp_and_split_path_naming() {
        let cut = temp_cut_path(r"C:\work\DJI_0001.mp4");
        assert!(cut
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".__temp_cut__."));
        let (p1, p2) = split_output_paths(r"C:\work\DJI_0001.mp4");
        assert_eq!(p1.file_name().unwrap().to_string_lossy(), "DJI_0001_1.mp4");
        assert_eq!(p2.file_name().unwrap().to_string_lossy(), "DJI_0001_2.mp4");
        let tmp = temp_split_part1_path("/tmp/foo.mov");
        assert!(tmp
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".__temp_part1__."));
    }

    #[test]
    fn validate_trim_rejects_inverted_range() {
        assert!(validate_trim_range(5.0, 2.0).is_err());
        assert!(validate_trim_range(-1.0, 2.0).is_err());
        assert!((validate_trim_range(1.0, 3.5).unwrap() - 2.5).abs() < 1e-9);
    }
}
