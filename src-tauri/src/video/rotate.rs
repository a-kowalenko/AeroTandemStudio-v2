//! Pixel-rotate videos via FFmpeg `transpose` (re-encode).
//!
//! Metadata-only rotation is intentionally avoided: HTML5 preview, concat, and
//! export must see upright pixels. Overwrite uses the same cut-undo backups as trim.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use thiserror::Error;

use super::concat;
use super::cutter::{temp_cut_path, CutResult};
use super::encode_profile::EncodeProfile;
use super::encoding_quality::resolve_output_codec;
use super::ffmpeg::{ffmpeg_probe_stderr, probe_duration_secs, run_ffmpeg, FfmpegError, ProgressCallback};
use super::hw_accel::{detect_hardware, EncodingParams};
use super::probe;
use super::progress::EncodeProgress;
use super::reencode_confirm::{
    self, ReencodeAskFn, ReencodeIntent, ReencodeKind, ReencodeParams,
};

#[derive(Debug, Error)]
pub enum RotateError {
    #[error(transparent)]
    Ffmpeg(#[from] super::ffmpeg::FfmpegError),
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Normalize to `{0, 90, 180, 270}`; `0` means no-op.
pub fn normalize_rotation_degrees(degrees: i32) -> Result<u32, RotateError> {
    let d = degrees.rem_euclid(360);
    if d % 90 != 0 {
        return Err(RotateError::Message(
            "Drehung muss ein Vielfaches von 90° sein".into(),
        ));
    }
    Ok(d as u32)
}

/// FFmpeg `-vf` chain for clockwise quarter-turns (0 → empty / error at call site).
pub fn transpose_filter_for_degrees(degrees: u32) -> Result<String, RotateError> {
    match degrees {
        90 => Ok("transpose=1".into()),
        180 => Ok("transpose=1,transpose=1".into()),
        270 => Ok("transpose=2".into()),
        0 => Err(RotateError::Message("Keine Drehung nötig (0°)".into())),
        _ => Err(RotateError::Message(
            "Drehung muss 90, 180 oder 270 Grad sein".into(),
        )),
    }
}

/// Build re-encode args: transpose filter + HW/SW encoder, audio copy when present.
pub fn build_rotate_video_args(
    input: &str,
    output: &str,
    vf: &str,
    params: &EncodingParams,
    has_audio: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());
    args.push("-hide_banner".into());
    args.extend(params.input_params.iter().cloned());
    args.push("-i".into());
    args.push(input.to_string());
    args.push("-vf".into());
    args.push(vf.to_string());
    args.extend(params.output_params.iter().cloned());
    args.extend([
        "-map".into(),
        "0:v:0".into(),
    ]);
    if has_audio {
        args.extend([
            "-map".into(),
            "0:a:0?".into(),
            "-c:a".into(),
            "copy".into(),
        ]);
    }
    // Clear stale display-rotation hints after baking pixels.
    args.extend([
        "-metadata:s:v:0".into(),
        "rotate=0".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.to_string(),
    ]);
    args
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

/// Rotate working-copy video in place (`overwrite=true`) or write to `output`.
pub fn rotate_video(
    ffmpeg: &Path,
    input: &str,
    degrees: i32,
    output: Option<&str>,
    overwrite: bool,
    on_progress: ProgressCallback,
    on_reencode: Option<&ReencodeAskFn>,
) -> Result<CutResult, RotateError> {
    if !Path::new(input).is_file() {
        return Err(RotateError::Message(format!("input file not found: {input}")));
    }
    let deg = normalize_rotation_degrees(degrees)?;
    if deg == 0 {
        return Err(RotateError::Message("Keine Drehung nötig (0°)".into()));
    }
    let vf = transpose_filter_for_degrees(deg)?;

    let (target, is_overwrite) = if overwrite {
        (temp_cut_path(input), true)
    } else {
        let out = output
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                RotateError::Message("output path is required when overwrite=false".into())
            })?;
        (PathBuf::from(out), false)
    };
    let target_str = target.to_string_lossy().to_string();

    let backup = if is_overwrite {
        Some(
            super::cut_undo::prepare_overwrite_backup(input)
                .map_err(|e| RotateError::Message(e.to_string()))?,
        )
    } else {
        None
    };

    let rotate_result = (|| -> Result<CutResult, RotateError> {
        let hw = detect_hardware();
        let probe_txt = ffmpeg_probe_stderr(ffmpeg, input).unwrap_or_default();
        let body_codec = probe::parse_video_metadata_from_probe(&probe_txt)
            .map(|m| m.codec)
            .unwrap_or_else(|| "h264".into());
        let recommended = EncodeProfile::recommend(
            ReencodeKind::Rotate,
            15,
            hw.available,
            Some(&body_codec),
        );
        let intent = ReencodeIntent::new(
            ReencodeKind::Rotate,
            "Drehen erfordert Neu-Kodierung (Pixel-Rotation)",
        )
        .with_params(ReencodeParams {
            degrees: Some(deg as i32),
            strategy: Some(format!("rotate-{deg}")),
            details: vec![format!("transpose filter: {vf}")],
            crf: Some(recommended.crf),
            hw_accel: Some(recommended.hw_accel),
            target_codec: Some(recommended.codec.clone()),
            encoder: None,
            ..Default::default()
        })
        .with_recommended(recommended);
        emit(
            &on_progress,
            3.0,
            "Neu-Kodierung — warte auf Bestätigung…",
        );
        let profile = match reencode_confirm::require_confirm(on_reencode, &intent) {
            Ok(p) => p,
            Err(()) => return Err(RotateError::Ffmpeg(FfmpegError::Cancelled)),
        };
        emit(
            &on_progress,
            5.0,
            "Drehen erfordert Neu-Kodierung…",
        );
        let out_codec = resolve_output_codec(profile.codec_preference(), &body_codec);
        // Software decode: transpose filter needs CPU frames.
        let (encoder, output_params) = profile.to_encode_output_params(&hw, out_codec);
        let params = EncodingParams {
            input_params: Vec::new(),
            output_params,
            encoder,
        };
        let duration = probe_duration_secs(ffmpeg, input).unwrap_or(1.0);
        let has_audio = concat::probe_has_audio(ffmpeg, input).unwrap_or(true);
        let args = build_rotate_video_args(input, &target_str, &vf, &params, has_audio);
        run_ffmpeg(ffmpeg, &args, duration.max(0.1), Arc::clone(&on_progress))?;

        let final_output = if is_overwrite {
            emit(&on_progress, 98.0, "Ersetze Original…");
            if !target.is_file() {
                return Err(RotateError::Message("temp rotate output missing".into()));
            }
            fs::rename(&target, input)?;
            input.to_string()
        } else {
            target_str.clone()
        };

        emit(&on_progress, 100.0, "end");
        Ok(CutResult {
            output: final_output,
            method: format!("rotate-{deg}"),
            overwritten: is_overwrite,
            reencode_reason: Some(
                "Drehen erfordert Neu-Kodierung (Pixel-Rotation)".into(),
            ),
        })
    })();

    match rotate_result {
        Ok(res) => {
            if let Some(b) = backup {
                super::cut_undo::commit_trim_undo(input, b);
            }
            Ok(res)
        }
        Err(e) => {
            if let Some(Some(b)) = backup {
                super::cut_undo::discard_backup(&b);
            }
            let _ = fs::remove_file(&target);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::hw_accel::EncodingParams;

    #[test]
    fn normalize_wraps_and_rejects() {
        assert_eq!(normalize_rotation_degrees(90).unwrap(), 90);
        assert_eq!(normalize_rotation_degrees(-90).unwrap(), 270);
        assert_eq!(normalize_rotation_degrees(450).unwrap(), 90);
        assert_eq!(normalize_rotation_degrees(0).unwrap(), 0);
        assert!(normalize_rotation_degrees(45).is_err());
    }

    #[test]
    fn transpose_filter_quarters() {
        assert_eq!(transpose_filter_for_degrees(90).unwrap(), "transpose=1");
        assert_eq!(
            transpose_filter_for_degrees(180).unwrap(),
            "transpose=1,transpose=1"
        );
        assert_eq!(transpose_filter_for_degrees(270).unwrap(), "transpose=2");
        assert!(transpose_filter_for_degrees(0).is_err());
    }

    #[test]
    fn rotate_args_include_vf_and_encoder() {
        let params = EncodingParams::software();
        let args = build_rotate_video_args("in.mp4", "out.mp4", "transpose=1", &params, true);
        let vf = args.iter().position(|a| a == "-vf").unwrap();
        assert_eq!(args[vf + 1], "transpose=1");
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"copy".into())); // audio copy
        assert!(args.contains(&"rotate=0".into()));
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(i < vf);
    }

    #[test]
    fn rotate_args_omit_audio_when_absent() {
        let params = EncodingParams::software();
        let args = build_rotate_video_args("in.mp4", "out.mp4", "transpose=2", &params, false);
        assert!(!args.iter().any(|a| a == "0:a:0?"));
        assert!(args.contains(&"0:v:0".into()));
    }
}
