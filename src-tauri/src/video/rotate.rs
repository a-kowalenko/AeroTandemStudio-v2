//! Quarter-turn helpers for clip rotation (OPT-26).
//!
//! Rotation is an edit value per body clip; source files are never re-encoded.
//! Pixels are rotated once at export (`concat`), in the WM preview video, and in
//! frames extracted from the cutter.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum RotateError {
    #[error("{0}")]
    Message(String),
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
/// 180° uses `hflip,vflip` (same image as two transposes, far cheaper).
pub fn transpose_filter_for_degrees(degrees: u32) -> Result<String, RotateError> {
    match degrees {
        90 => Ok("transpose=1".into()),
        180 => Ok("hflip,vflip".into()),
        270 => Ok("transpose=2".into()),
        0 => Err(RotateError::Message("Keine Drehung nötig (0°)".into())),
        _ => Err(RotateError::Message(
            "Drehung muss 90, 180 oder 270 Grad sein".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(transpose_filter_for_degrees(180).unwrap(), "hflip,vflip");
        assert_eq!(transpose_filter_for_degrees(270).unwrap(), "transpose=2");
        assert!(transpose_filter_for_degrees(0).is_err());
    }
}
