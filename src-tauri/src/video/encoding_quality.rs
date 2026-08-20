//! Encoding quality helpers (port of legacy `encoding_quality.py`).
//!
//! CRF clamping, codec preference (h264 / h265 / auto), and FFmpeg quality params
//! for software and hardware encoders.

use serde::{Deserialize, Serialize};

use super::concat::{normalize_vcodec_name, VideoCodec};
use super::hw_accel::{HwAccelInfo, HwType};

/// User / config codec preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodecPreference {
    #[default]
    Auto,
    H264,
    H265,
}

impl VideoCodecPreference {
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "h264" | "avc" => Self::H264,
            "h265" | "hevc" => Self::H265,
            _ => Self::Auto,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::H264 => "h264",
            Self::H265 => "h265",
        }
    }
}

/// Clamp CRF to the valid libx264/libx265 range `[0, 51]`.
/// `default` is used when the caller passes a sentinel (e.g. after a failed parse).
pub fn clamp_crf(crf: i32, default: i32) -> u8 {
    let value = if (0..=51).contains(&crf) {
        crf
    } else if crf < 0 || crf > 51 {
        crf.clamp(0, 51)
    } else {
        default.clamp(0, 51)
    };
    value as u8
}

/// Resolve preference against a probed body codec (`auto` → match body, else h264).
pub fn resolve_output_codec(pref: VideoCodecPreference, body_codec: &str) -> VideoCodec {
    match pref {
        VideoCodecPreference::H264 => VideoCodec::H264,
        VideoCodecPreference::H265 => VideoCodec::Hevc,
        VideoCodecPreference::Auto => match normalize_vcodec_name(body_codec) {
            VideoCodec::Hevc => VideoCodec::Hevc,
            _ => VideoCodec::H264,
        },
    }
}

/// Pick a shared target when clips disagree: majority wins; ties prefer H.264 (compat).
pub fn majority_body_codec(codecs: &[VideoCodec]) -> VideoCodec {
    let mut h264 = 0usize;
    let mut hevc = 0usize;
    for c in codecs {
        match c {
            VideoCodec::H264 => h264 += 1,
            VideoCodec::Hevc => hevc += 1,
            VideoCodec::Other => {}
        }
    }
    if hevc > h264 {
        VideoCodec::Hevc
    } else {
        VideoCodec::H264
    }
}

/// Canonical preference string for dialogs / profiles (`h264` | `h265`).
pub fn video_codec_to_pref_str(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::Hevc => "h265",
        _ => "h264",
    }
}

/// Pick FFmpeg `-c:v` encoder name for the resolved codec + detected HW.
pub fn select_encoder(hw: &HwAccelInfo, codec: VideoCodec) -> String {
    match (&hw.hw_type, codec) {
        (HwType::Nvidia, VideoCodec::H264) => "h264_nvenc".into(),
        (HwType::Nvidia, VideoCodec::Hevc) => "hevc_nvenc".into(),
        (HwType::Videotoolbox, VideoCodec::H264) => "h264_videotoolbox".into(),
        (HwType::Videotoolbox, VideoCodec::Hevc) => "hevc_videotoolbox".into(),
        (_, VideoCodec::Hevc) => "libx265".into(),
        (_, _) => "libx264".into(),
    }
}

/// Software quality flags (CRF / preset). Does **not** include `-c:v`.
///
/// Preset `veryfast` keeps CRF-driven quality while encoding much faster than `medium`
/// (slightly larger files — typical for camera footage).
pub fn build_software_quality_params(encoder: &str, crf: u8, codec: VideoCodec) -> Vec<String> {
    let crf = clamp_crf(i32::from(crf), 18);
    let encoder = encoder.to_ascii_lowercase();
    let mut params = vec![
        "-g".into(),
        "30".into(),
        "-keyint_min".into(),
        "30".into(),
        "-sc_threshold".into(),
        "0".into(),
    ];

    if encoder == "libx264" {
        params.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            crf.to_string(),
        ]);
        if codec != VideoCodec::Hevc {
            params.extend([
                "-x264-params".into(),
                "repeat-headers=1:nal-hrd=none:open-gop=0".into(),
            ]);
        }
    } else if encoder == "libx265" {
        let hevc_crf = (u16::from(crf) + 2).min(51);
        params.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            hevc_crf.to_string(),
        ]);
        append_hevc_splice_encode_params(&mut params, &encoder, 30);
    } else {
        params.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            crf.to_string(),
        ]);
    }

    params
}

/// Hardware quality flags (CQ / QP). Does **not** include `-c:v`.
pub fn build_hw_quality_params(
    hw: &HwAccelInfo,
    encoder: &str,
    crf: u8,
    codec: VideoCodec,
) -> Vec<String> {
    let crf = clamp_crf(i32::from(crf), 18);
    let hevc = codec == VideoCodec::Hevc;
    let gop = ["-g", "30", "-keyint_min", "30"];
    let enc = encoder.to_ascii_lowercase();

    match &hw.hw_type {
        HwType::Nvidia => {
            let cq = if hevc {
                (u16::from(crf) + 2).min(51)
            } else {
                u16::from(crf)
            };
            let mut params = vec![
                "-preset".into(),
                "p4".into(),
                "-tune".into(),
                "hq".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                cq.to_string(),
                "-b:v".into(),
                "0".into(),
            ];
            params.extend(gop.iter().map(|s| (*s).to_string()));
            if hevc {
                append_hevc_splice_encode_params(&mut params, &enc, 30);
            }
            params
        }
        HwType::Videotoolbox => {
            let q = (100i32 - i32::from(crf)).clamp(40, 90);
            let mut params = vec![
                "-profile:v".into(),
                "high".into(),
                "-q:v".into(),
                q.to_string(),
                "-b:v".into(),
                "0".into(),
            ];
            params.extend(gop.iter().map(|s| (*s).to_string()));
            params
        }
        HwType::Software => build_software_quality_params(encoder, crf, codec),
    }
}

/// HEVC splice-friendly extras (no B-frames, closed GOP, hvc1 tag).
pub fn append_hevc_splice_encode_params(params: &mut Vec<String>, encoder: &str, fps: u32) {
    let fps = fps.max(1);
    params.extend([
        "-bf".into(),
        "0".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-tag:v".into(),
        "hvc1".into(),
    ]);
    let enc = encoder.to_ascii_lowercase();
    if enc == "libx265" {
        params.extend([
            "-x265-params".into(),
            format!(
                "keyint={fps}:min-keyint={fps}:scenecut=0:open-gop=0:repeat-headers=1:aud=1:bframes=0"
            ),
        ]);
    } else if enc.ends_with("_nvenc") {
        params.extend(["-no-scenecut".into(), "1".into()]);
    }
}

/// Strip `-hwaccel` / `-hwaccel_device` pairs (CPU filters like scale/drawtext need this).
#[allow(dead_code)]
pub fn strip_hwaccel_input_params(input_params: &[String]) -> Vec<String> {
    let mut stripped = Vec::with_capacity(input_params.len());
    let mut i = 0;
    while i < input_params.len() {
        if input_params[i] == "-hwaccel" || input_params[i] == "-hwaccel_device" {
            i += 2;
            continue;
        }
        stripped.push(input_params[i].clone());
        i += 1;
    }
    stripped
}

/// Build `-c:v` + quality params for encode jobs.
pub fn build_encode_output_params(
    hw: &HwAccelInfo,
    codec: VideoCodec,
    crf: u8,
    force_software: bool,
) -> (String, Vec<String>) {
    if force_software || !hw.available {
        let encoder = match codec {
            VideoCodec::Hevc => "libx265".to_string(),
            _ => "libx264".to_string(),
        };
        let mut out = vec!["-c:v".into(), encoder.clone()];
        out.extend(build_software_quality_params(&encoder, crf, codec));
        return (encoder, out);
    }

    let encoder = select_encoder(hw, codec);
    let mut out = vec!["-c:v".into(), encoder.clone()];
    out.extend(build_hw_quality_params(hw, &encoder, crf, codec));
    (encoder, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_crf_bounds() {
        assert_eq!(clamp_crf(18, 18), 18);
        assert_eq!(clamp_crf(-1, 18), 0);
        assert_eq!(clamp_crf(99, 18), 51);
        assert_eq!(clamp_crf(0, 18), 0);
        assert_eq!(clamp_crf(51, 18), 51);
    }

    #[test]
    fn resolve_auto_follows_body() {
        assert_eq!(
            resolve_output_codec(VideoCodecPreference::Auto, "hevc"),
            VideoCodec::Hevc
        );
        assert_eq!(
            resolve_output_codec(VideoCodecPreference::Auto, "h264"),
            VideoCodec::H264
        );
        assert_eq!(
            resolve_output_codec(VideoCodecPreference::H265, "h264"),
            VideoCodec::Hevc
        );
    }

    #[test]
    fn majority_prefers_hevc_when_more() {
        assert_eq!(
            majority_body_codec(&[VideoCodec::H264, VideoCodec::Hevc, VideoCodec::Hevc]),
            VideoCodec::Hevc
        );
    }

    #[test]
    fn majority_tie_prefers_h264() {
        assert_eq!(
            majority_body_codec(&[VideoCodec::H264, VideoCodec::Hevc]),
            VideoCodec::H264
        );
        assert_eq!(majority_body_codec(&[]), VideoCodec::H264);
    }

    #[test]
    fn codec_preference_parse() {
        assert_eq!(VideoCodecPreference::parse("auto"), VideoCodecPreference::Auto);
        assert_eq!(VideoCodecPreference::parse("H264"), VideoCodecPreference::H264);
        assert_eq!(VideoCodecPreference::parse("hevc"), VideoCodecPreference::H265);
    }

    #[test]
    fn software_params_include_crf() {
        let p = build_software_quality_params("libx264", 18, VideoCodec::H264);
        assert!(p.contains(&"-crf".into()));
        assert!(p.contains(&"18".into()));
        assert!(p.contains(&"-preset".into()));
        assert!(p.contains(&"veryfast".into()));
    }

    #[test]
    fn nvenc_params_use_cq() {
        let hw = HwAccelInfo::nvidia();
        let p = build_hw_quality_params(&hw, "h264_nvenc", 18, VideoCodec::H264);
        assert!(p.contains(&"-cq".into()));
        assert!(p.contains(&"18".into()));
        assert!(p.contains(&"p4".into()));
    }

    #[test]
    fn strip_hwaccel_removes_pairs() {
        let input = vec![
            "-hwaccel".into(),
            "cuda".into(),
            "-hwaccel_device".into(),
            "0".into(),
            "-something".into(),
        ];
        assert_eq!(
            strip_hwaccel_input_params(&input),
            vec!["-something".to_string()]
        );
    }

    #[test]
    fn select_encoder_nvidia_hevc() {
        let hw = HwAccelInfo::nvidia();
        assert_eq!(select_encoder(&hw, VideoCodec::Hevc), "hevc_nvenc");
        assert_eq!(select_encoder(&hw, VideoCodec::H264), "h264_nvenc");
    }

    #[test]
    fn build_encode_output_includes_codec() {
        let hw = HwAccelInfo::software();
        let (enc, params) = build_encode_output_params(&hw, VideoCodec::H264, 18, false);
        assert_eq!(enc, "libx264");
        assert_eq!(params[0], "-c:v");
        assert_eq!(params[1], "libx264");
    }
}
