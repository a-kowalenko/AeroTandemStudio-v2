//! Hardware-encoder detection (port of legacy `hardware_acceleration.py`).
//!
//! Phase 0 priority: NVENC (Windows) → VideoToolbox (macOS) → libx264.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::ffmpeg::find_ffmpeg;

static HW_CACHE: Lazy<Mutex<Option<HwAccelInfo>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HwType {
    Nvidia,
    Videotoolbox,
    Software,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HwAccelInfo {
    pub available: bool,
    pub hw_type: HwType,
    pub encoder: String,
    pub hwaccel: Option<String>,
    pub extra_params: Vec<String>,
}

impl HwAccelInfo {
    pub fn software() -> Self {
        Self {
            available: false,
            hw_type: HwType::Software,
            encoder: "libx264".into(),
            hwaccel: None,
            extra_params: vec!["-preset".into(), "medium".into(), "-crf".into(), "23".into()],
        }
    }

    pub fn nvidia() -> Self {
        Self {
            available: true,
            hw_type: HwType::Nvidia,
            encoder: "h264_nvenc".into(),
            hwaccel: Some("cuda".into()),
            extra_params: vec!["-preset".into(), "p4".into(), "-tune".into(), "hq".into()],
        }
    }

    #[allow(dead_code)] // used on macOS + unit tests
    pub fn videotoolbox() -> Self {
        Self {
            available: true,
            hw_type: HwType::Videotoolbox,
            encoder: "h264_videotoolbox".into(),
            hwaccel: Some("videotoolbox".into()),
            // VBR + GOP aligned with legacy
            extra_params: vec!["-b:v".into(), "0".into(), "-g".into(), "30".into()],
        }
    }

    #[allow(dead_code)]
    pub fn label(&self) -> &'static str {
        match self.hw_type {
            HwType::Nvidia => "NVIDIA NVENC",
            HwType::Videotoolbox => "Apple VideoToolbox",
            HwType::Software => "Software (libx264)",
        }
    }
}

/// Encoding parameter sets used when building FFmpeg CLI args.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodingParams {
    pub input_params: Vec<String>,
    pub output_params: Vec<String>,
    pub encoder: String,
}

impl EncodingParams {
    pub fn from_hw(hw: &HwAccelInfo, use_hwaccel_decode: bool) -> Self {
        let mut input_params = Vec::new();
        if use_hwaccel_decode {
            if let Some(accel) = &hw.hwaccel {
                input_params.push("-hwaccel".into());
                input_params.push(accel.clone());
            }
        }

        let mut output_params = vec!["-c:v".into(), hw.encoder.clone()];
        output_params.extend(hw.extra_params.iter().cloned());

        Self {
            input_params,
            output_params,
            encoder: hw.encoder.clone(),
        }
    }

    #[allow(dead_code)] // unit tests
    pub fn software() -> Self {
        Self::from_hw(&HwAccelInfo::software(), false)
    }
}

/// Detect available hardware encoder. Result is cached for the process lifetime.
pub fn detect_hardware() -> HwAccelInfo {
    if let Ok(guard) = HW_CACHE.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }

    let result = detect_hardware_uncached();

    if let Ok(mut guard) = HW_CACHE.lock() {
        *guard = Some(result.clone());
    }

    result
}

/// Clear the in-process hardware detection cache.
pub fn clear_hw_cache() {
    if let Ok(mut guard) = HW_CACHE.lock() {
        *guard = None;
    }
}

fn detect_hardware_uncached() -> HwAccelInfo {
    #[cfg(target_os = "windows")]
    {
        if has_nvidia_gpu() && encoder_listed("h264_nvenc") {
            return HwAccelInfo::nvidia();
        }
    }

    #[cfg(target_os = "macos")]
    {
        if encoder_listed("h264_videotoolbox") {
            return HwAccelInfo::videotoolbox();
        }
    }

    HwAccelInfo::software()
}

fn encoder_listed(encoder_name: &str) -> bool {
    let Ok(ffmpeg) = find_ffmpeg() else {
        return false;
    };

    let output = Command::new(&ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains(encoder_name)
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
fn has_nvidia_gpu() -> bool {
    // Prefer nvidia-smi (fast, definitive when present)
    if let Ok(out) = Command::new("nvidia-smi").arg("-L").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("GPU") {
                return true;
            }
        }
    }

    // Fallback: enumerate video controllers via PowerShell (wmic is deprecated)
    let script = "(Get-CimInstance Win32_VideoController).Name -join '|'";
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if text.contains("nvidia")
                || text.contains("geforce")
                || text.contains("quadro")
                || text.contains("rtx")
            {
                return true;
            }
        }
    }

    false
}

/// Build FFmpeg args for a 1080p@30fps transcode.
///
/// Pure function — unit-tested without spawning FFmpeg.
pub fn build_encode_args(input: &str, output: &str, params: &EncodingParams) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    args.push("-y".into());
    args.push("-hide_banner".into());

    args.extend(params.input_params.iter().cloned());

    args.push("-i".into());
    args.push(input.to_string());

    // Scale to 1080p height, keep aspect; force 30 fps
    args.push("-vf".into());
    args.push("scale=-2:1080".into());
    args.push("-r".into());
    args.push("30".into());

    args.extend(params.output_params.iter().cloned());

    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());

    // Machine-readable progress on stdout
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());

    args.push(output.to_string());
    args
}

/// Convenience: detect HW and build encode args.
/// Hardware decode is disabled in Phase 0 to avoid CUDA filter-graph issues with `-vf scale`.
pub fn build_encode_command(input: &str, output: &str) -> (HwAccelInfo, Vec<String>) {
    let hw = detect_hardware();
    // Encode with HW encoder when available, but keep decode/filter on CPU for Phase 0.
    let params = EncodingParams::from_hw(&hw, false);
    let args = build_encode_args(input, output, &params);
    (hw, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_params_use_libx264_crf() {
        let params = EncodingParams::software();
        assert_eq!(params.encoder, "libx264");
        assert!(params.input_params.is_empty());
        assert_eq!(
            params.output_params,
            vec!["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
        );
    }

    #[test]
    fn nvidia_params_include_nvenc_preset() {
        let params = EncodingParams::from_hw(&HwAccelInfo::nvidia(), false);
        assert_eq!(params.encoder, "h264_nvenc");
        assert!(params.input_params.is_empty());
        assert!(params.output_params.contains(&"h264_nvenc".into()));
        assert!(params.output_params.contains(&"p4".into()));
    }

    #[test]
    fn nvidia_with_hwaccel_decode_adds_cuda() {
        let params = EncodingParams::from_hw(&HwAccelInfo::nvidia(), true);
        assert_eq!(params.input_params, vec!["-hwaccel", "cuda"]);
    }

    #[test]
    fn videotoolbox_params() {
        let params = EncodingParams::from_hw(&HwAccelInfo::videotoolbox(), false);
        assert_eq!(params.encoder, "h264_videotoolbox");
        assert!(params.output_params.contains(&"-b:v".into()));
        assert!(params.output_params.contains(&"0".into()));
        assert!(params.output_params.contains(&"-g".into()));
        assert!(params.output_params.contains(&"30".into()));
        assert!(params.input_params.is_empty());
    }

    #[test]
    fn videotoolbox_with_hwaccel_decode_adds_videotoolbox() {
        let params = EncodingParams::from_hw(&HwAccelInfo::videotoolbox(), true);
        assert_eq!(params.input_params, vec!["-hwaccel", "videotoolbox"]);
    }

    #[test]
    fn videotoolbox_encode_args_order() {
        let params = EncodingParams::from_hw(&HwAccelInfo::videotoolbox(), false);
        let args = build_encode_args("in.mov", "out.mp4", &params);
        let cv = args.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(args.get(cv + 1).map(String::as_str), Some("h264_videotoolbox"));
        assert!(args.contains(&"-b:v".into()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn videotoolbox_info_label() {
        let hw = HwAccelInfo::videotoolbox();
        assert!(hw.available);
        assert_eq!(hw.hw_type, HwType::Videotoolbox);
        assert_eq!(hw.hwaccel.as_deref(), Some("videotoolbox"));
        assert_eq!(hw.label(), "Apple VideoToolbox");
    }

    #[test]
    fn build_encode_args_targets_1080p_30fps() {
        let params = EncodingParams::software();
        let args = build_encode_args("in.mp4", "out.mp4", &params);

        assert!(args.contains(&"-y".into()));
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"in.mp4".into()));
        assert!(args.contains(&"-vf".into()));
        assert!(args.contains(&"scale=-2:1080".into()));
        assert!(args.contains(&"-r".into()));
        assert!(args.contains(&"30".into()));
        assert!(args.contains(&"-c:v".into()));
        assert!(args.contains(&"libx264".into()));
        assert!(args.contains(&"-c:a".into()));
        assert!(args.contains(&"aac".into()));
        assert!(args.contains(&"-progress".into()));
        assert!(args.contains(&"pipe:1".into()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn build_encode_args_preserves_arg_order_for_input() {
        let params = EncodingParams::from_hw(&HwAccelInfo::nvidia(), true);
        let args = build_encode_args("a.mp4", "b.mp4", &params);

        let hwaccel_pos = args.iter().position(|a| a == "-hwaccel").unwrap();
        let i_pos = args.iter().position(|a| a == "-i").unwrap();
        assert!(hwaccel_pos < i_pos, "hwaccel must come before -i");
    }

    #[test]
    fn software_fallback_info() {
        let hw = HwAccelInfo::software();
        assert!(!hw.available);
        assert_eq!(hw.hw_type, HwType::Software);
        assert_eq!(hw.encoder, "libx264");
    }
}
