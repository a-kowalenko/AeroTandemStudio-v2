//! Post-concat display rotation for upright delivery (Avidemux-style: stream-copy remux).

use std::path::{Path, PathBuf};

use super::concat::{self, ConcatError};
use super::ffmpeg::{ffmpeg_probe_stderr, FfmpegError, ProgressCallback};
use super::probe::{compatible_stream_key_from_probe, has_audio_stream_from_probe, VideoRotationProbe};
use crate::storage::logging;

/// True when probe reports a non-zero known soft rotation (display matrix / rotate tag).
pub fn body_needs_upright_delivery(rotation: &VideoRotationProbe) -> bool {
    rotation.clone().known_degrees().is_some_and(|d| d != 0)
}

/// When OPT-27 harmonize ran, Clip 1 had this mount rotation before merge (merge may strip tags).
pub fn orient_merge_upright_reference_deg(reference_clockwise_deg: Option<u32>) -> Option<u32> {
    reference_clockwise_deg.filter(|d| *d != 0)
}

/// Clockwise display rotation to apply on the merged body (stream-copy), if any.
pub fn delivery_display_rotation_clockwise_deg(
    probe_deg: Option<u32>,
    orient_reference_clockwise_deg: Option<u32>,
) -> Option<u32> {
    if probe_deg.is_some_and(|d| d != 0) {
        return None;
    }
    orient_merge_upright_reference_deg(orient_reference_clockwise_deg)
}

fn concat_error_to_ffmpeg(err: ConcatError) -> FfmpegError {
    match err {
        ConcatError::Ffmpeg(e) => e,
        other => FfmpegError::Message(other.to_string()),
    }
}

/// After stream-copy concat, re-apply Clip 1 display rotation when compatible prep stripped
/// metadata (`rotate=0` probe) but pixels are still in mount orientation.
///
/// Uses `-c copy` + `-display_rotation` (no pixel re-encode). Skips when probe already reports
/// non-zero soft rotation.
pub fn maybe_bake_body_upright_for_delivery(
    ffmpeg: &Path,
    input: &str,
    work_dir: &Path,
    _hw_accel_enabled: bool,
    _crf: u8,
    on_progress: ProgressCallback,
    orient_reference_clockwise_deg: Option<u32>,
) -> Result<String, FfmpegError> {
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    let has_audio = has_audio_stream_from_probe(&stderr);
    let Some(key) = compatible_stream_key_from_probe(&stderr, has_audio) else {
        return Ok(input.to_string());
    };
    let probe_deg = key.rotation.known_degrees();
    let Some(clockwise_deg) =
        delivery_display_rotation_clockwise_deg(probe_deg, orient_reference_clockwise_deg)
    else {
        return Ok(input.to_string());
    };

    let out_path: PathBuf = work_dir.join("body_display.mp4");
    let output = out_path.to_string_lossy().into_owned();

    logging::info(
        "concat",
        format!("auto: upright delivery remux (display={clockwise_deg}°, stream-copy)"),
    );
    emit_step_label(&on_progress, "Richte Video für Auslieferung aus…");

    concat::remux_with_display_rotation(ffmpeg, input, &output, clockwise_deg, on_progress)
        .map_err(concat_error_to_ffmpeg)?;

    if input != output.as_str() && Path::new(input).starts_with(work_dir) {
        let _ = std::fs::remove_file(input);
    }
    Ok(output)
}

fn emit_step_label(on_progress: &ProgressCallback, label: &str) {
    on_progress(super::progress::progress_from_times(0.0, 100.0, label));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_needs_upright_when_soft_rotation_nonzero() {
        assert!(!body_needs_upright_delivery(&VideoRotationProbe::Known(0)));
        assert!(body_needs_upright_delivery(&VideoRotationProbe::Known(180)));
        assert!(body_needs_upright_delivery(&VideoRotationProbe::Known(90)));
        assert!(!body_needs_upright_delivery(&VideoRotationProbe::Unknown { raw_deg: 45 }));
    }

    #[test]
    fn delivery_display_rotation_when_merge_stripped_metadata() {
        assert_eq!(delivery_display_rotation_clockwise_deg(Some(0), Some(180)), Some(180));
        assert_eq!(delivery_display_rotation_clockwise_deg(None, Some(180)), Some(180));
        assert_eq!(delivery_display_rotation_clockwise_deg(Some(180), Some(180)), None);
        assert_eq!(delivery_display_rotation_clockwise_deg(Some(0), Some(0)), None);
        assert_eq!(delivery_display_rotation_clockwise_deg(None, None), None);
    }
}
