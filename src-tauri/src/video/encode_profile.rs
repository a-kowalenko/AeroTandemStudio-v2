//! Shared encode profile for preview, export, rotate, and re-encode confirms.
//!
//! Preview and export use the same profile so Preview-Reuse stays quality-identical.

use serde::{Deserialize, Serialize};

use super::encoding_quality::{
    build_encode_output_params, clamp_crf, VideoCodecPreference,
};
use super::hw_accel::HwAccelInfo;
use super::reencode_confirm::ReencodeKind;

/// Named preset shown in the re-encode confirmation dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EncodePresetId {
    /// Context-aware default (often max quality for rotate, balanced otherwise).
    #[default]
    Recommended,
    MaxQuality,
    Balanced,
    Fast,
    /// Browser / AMS friendly: H.264, 1080p@30.
    Compat,
    /// User overrode individual fields after picking a preset.
    Custom,
}

impl EncodePresetId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::MaxQuality => "max_quality",
            Self::Balanced => "balanced",
            Self::Fast => "fast",
            Self::Compat => "compat",
            Self::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "recommended" | "empfohlen" => Some(Self::Recommended),
            "max_quality" | "max" | "quality" => Some(Self::MaxQuality),
            "balanced" | "standard" | "ausgewogen" => Some(Self::Balanced),
            "fast" | "schnell" => Some(Self::Fast),
            "compat" | "compatible" | "kompatibel" => Some(Self::Compat),
            "custom" | "benutzerdefiniert" => Some(Self::Custom),
            _ => None,
        }
    }

    pub fn all_selectable() -> &'static [EncodePresetId] {
        &[
            Self::Recommended,
            Self::MaxQuality,
            Self::Balanced,
            Self::Fast,
            Self::Compat,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScaleMode {
    /// Keep source resolution (preview == export).
    #[default]
    Source,
    /// Scale/pad to 1080p (compat / legacy preview).
    Fit1080p,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FpsMode {
    #[default]
    Source,
    Force30,
}

/// Full encode settings applied on proceed (and as config default for silent paths).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EncodeProfile {
    pub preset_id: EncodePresetId,
    /// Preference: `auto` | `h264` | `h265`
    pub codec: String,
    /// Concrete codec `auto` will use when known (`h264` | `h265`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_codec: Option<String>,
    pub crf: u8,
    /// libx264/libx265 preset (e.g. `medium`, `veryfast`).
    pub sw_preset: String,
    /// NVENC preset (e.g. `p4`, `p5`, `p6`).
    pub nvenc_preset: String,
    pub hw_accel: bool,
    pub scale_mode: ScaleMode,
    pub fps_mode: FpsMode,
    /// Short German explanation when this is the recommended profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommend_reason: Option<String>,
}

impl Default for EncodeProfile {
    fn default() -> Self {
        Self::balanced(true)
    }
}

impl EncodeProfile {
    pub fn balanced(hw_accel: bool) -> Self {
        Self {
            preset_id: EncodePresetId::Balanced,
            codec: "auto".into(),
            resolved_codec: None,
            crf: 18,
            sw_preset: "veryfast".into(),
            nvenc_preset: "p4".into(),
            hw_accel,
            scale_mode: ScaleMode::Source,
            fps_mode: FpsMode::Source,
            recommend_reason: None,
        }
    }

    pub fn max_quality(hw_accel: bool) -> Self {
        Self {
            preset_id: EncodePresetId::MaxQuality,
            codec: "auto".into(),
            resolved_codec: None,
            crf: 15,
            sw_preset: "slow".into(),
            nvenc_preset: "p6".into(),
            hw_accel,
            scale_mode: ScaleMode::Source,
            fps_mode: FpsMode::Source,
            recommend_reason: None,
        }
    }

    pub fn fast(hw_accel: bool) -> Self {
        Self {
            preset_id: EncodePresetId::Fast,
            codec: "auto".into(),
            resolved_codec: None,
            crf: 22,
            sw_preset: "ultrafast".into(),
            nvenc_preset: "p2".into(),
            hw_accel,
            scale_mode: ScaleMode::Source,
            fps_mode: FpsMode::Source,
            recommend_reason: None,
        }
    }

    pub fn compat(hw_accel: bool) -> Self {
        Self {
            preset_id: EncodePresetId::Compat,
            codec: "h264".into(),
            resolved_codec: Some("h264".into()),
            crf: 18,
            sw_preset: "medium".into(),
            nvenc_preset: "p4".into(),
            hw_accel,
            scale_mode: ScaleMode::Fit1080p,
            fps_mode: FpsMode::Force30,
            recommend_reason: None,
        }
    }

    /// Baseline from app config (preview CRF + HW flag). Preview == export.
    pub fn from_config_defaults(preview_crf: u8, hw_accel: bool, video_codec: &str) -> Self {
        let mut p = Self::balanced(hw_accel);
        p.crf = clamp_crf(i32::from(preview_crf), 18);
        let n = normalize_codec_pref(video_codec);
        match n.as_str() {
            "h264" | "h265" => {
                p.codec = n.clone();
                p.resolved_codec = Some(n);
            }
            _ => {
                p.codec = "auto".into();
                p.resolved_codec = None;
            }
        }
        p.preset_id = EncodePresetId::Balanced;
        p
    }

    /// Recommended profile for a re-encode kind.
    pub fn recommend(
        kind: ReencodeKind,
        base_crf: u8,
        hw_accel: bool,
        target_codec: Option<&str>,
    ) -> Self {
        let codec = target_codec
            .map(normalize_codec_pref)
            .unwrap_or_else(|| "auto".into());
        let crf = clamp_crf(i32::from(base_crf), 18);

        let mut profile = match kind {
            ReencodeKind::Rotate => {
                let mut p = Self::max_quality(hw_accel);
                p.recommend_reason = Some("Drehen — höhere Qualität empfohlen".into());
                p
            }
            ReencodeKind::PreviewClips
            | ReencodeKind::PreviewCombined
            | ReencodeKind::PreviewRemuxFallback => {
                let mut p = Self::balanced(hw_accel);
                // Preview == export: keep source geometry unless browser forces compat later.
                p.crf = crf;
                p.recommend_reason = Some("Preview = Export".into());
                p
            }
            ReencodeKind::IntroMux => {
                let mut p = Self::balanced(hw_accel);
                p.crf = crf;
                p.recommend_reason = Some("Intro+Body durchgängig kodieren".into());
                p
            }
            ReencodeKind::BodyParallel
            | ReencodeKind::ConcatFallback
            | ReencodeKind::RemuxFallback => {
                let mut p = Self::balanced(hw_accel);
                p.crf = crf;
                p.recommend_reason = Some("Ziel-Codec für gemischte Clips".into());
                p
            }
        };

        profile.preset_id = EncodePresetId::Recommended;
        // Prefer showing preference `auto` with a concrete resolved codec when known.
        match codec.as_str() {
            "h264" | "h265" => {
                profile.codec = "auto".into();
                profile.resolved_codec = Some(codec);
            }
            _ => {
                profile.codec = "auto".into();
                profile.resolved_codec = None;
            }
        }
        profile.hw_accel = hw_accel;
        if matches!(kind, ReencodeKind::Rotate) {
            // Keep max-quality CRF unless config was already stricter.
            if crf < profile.crf {
                profile.crf = crf;
            }
        } else {
            profile.crf = crf;
        }
        profile
    }

    /// Apply a named preset, preserving codec/hw from `base` where sensible.
    pub fn apply_preset(preset: EncodePresetId, base: &EncodeProfile) -> Self {
        let hw = base.hw_accel;
        let resolved = base.resolved_codec.clone();
        let mut p = match preset {
            EncodePresetId::Recommended => {
                // Re-derive from base's recommend_reason context: use max if reason mentions Drehen.
                if base
                    .recommend_reason
                    .as_deref()
                    .is_some_and(|r| r.contains("Drehen"))
                {
                    let mut m = Self::max_quality(hw);
                    m.preset_id = EncodePresetId::Recommended;
                    m.recommend_reason = base.recommend_reason.clone();
                    m.codec = if base.codec == "h264" || base.codec == "h265" {
                        base.codec.clone()
                    } else {
                        "auto".into()
                    };
                    m.resolved_codec = resolved.clone();
                    m
                } else {
                    let mut b = Self::balanced(hw);
                    b.preset_id = EncodePresetId::Recommended;
                    b.crf = base.crf;
                    b.codec = if base.codec == "h264" || base.codec == "h265" {
                        base.codec.clone()
                    } else {
                        "auto".into()
                    };
                    b.resolved_codec = resolved.clone();
                    b.recommend_reason = base.recommend_reason.clone();
                    b
                }
            }
            EncodePresetId::MaxQuality => {
                let mut m = Self::max_quality(hw);
                m.codec = if base.codec == "h264" || base.codec == "h265" {
                    base.codec.clone()
                } else {
                    "auto".into()
                };
                m.resolved_codec = resolved.clone();
                m
            }
            EncodePresetId::Balanced => {
                let mut b = Self::balanced(hw);
                b.codec = if base.codec == "h264" || base.codec == "h265" {
                    base.codec.clone()
                } else {
                    "auto".into()
                };
                b.resolved_codec = resolved.clone();
                b
            }
            EncodePresetId::Fast => {
                let mut f = Self::fast(hw);
                f.codec = if base.codec == "h264" || base.codec == "h265" {
                    base.codec.clone()
                } else {
                    "auto".into()
                };
                f.resolved_codec = resolved.clone();
                f
            }
            EncodePresetId::Compat => Self::compat(hw),
            EncodePresetId::Custom => {
                let mut c = base.clone();
                c.preset_id = EncodePresetId::Custom;
                c
            }
        };
        p.hw_accel = hw;
        p
    }

    /// Mark profile as custom after a manual field edit.
    #[allow(dead_code)]
    pub fn mark_custom(&mut self) {
        self.preset_id = EncodePresetId::Custom;
        self.recommend_reason = None;
    }

    pub fn codec_preference(&self) -> VideoCodecPreference {
        match self.codec.as_str() {
            "h264" => VideoCodecPreference::H264,
            "h265" => VideoCodecPreference::H265,
            _ => self
                .resolved_codec
                .as_deref()
                .map(VideoCodecPreference::parse)
                .filter(|p| !matches!(p, VideoCodecPreference::Auto))
                .unwrap_or(VideoCodecPreference::Auto),
        }
    }

    /// Build `-c:v` + quality flags, applying SW/NVENC preset overrides from this profile.
    pub fn to_encode_output_params(
        &self,
        hw: &HwAccelInfo,
        codec: super::concat::VideoCodec,
    ) -> (String, Vec<String>) {
        let force_sw = !self.hw_accel || !hw.available;
        let (encoder, mut params) =
            build_encode_output_params(hw, codec, self.crf, force_sw);
        replace_flag_value(&mut params, "-preset", preset_for_encoder(&encoder, self));
        (encoder, params)
    }
}

fn normalize_codec_pref(s: &str) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "h264" | "avc" | "avc1" => "h264".into(),
        "h265" | "hevc" | "hvc1" => "h265".into(),
        _ => "auto".into(),
    }
}

fn preset_for_encoder<'a>(encoder: &str, profile: &'a EncodeProfile) -> &'a str {
    let enc = encoder.to_ascii_lowercase();
    if enc.contains("nvenc") {
        profile.nvenc_preset.as_str()
    } else if enc.contains("videotoolbox") {
        ""
    } else {
        profile.sw_preset.as_str()
    }
}

fn replace_flag_value(args: &mut Vec<String>, flag: &str, new_value: &str) {
    if new_value.is_empty() {
        return;
    }
    if let Some(i) = args.iter().position(|a| a == flag) {
        if i + 1 < args.len() {
            args[i + 1] = new_value.to_string();
            return;
        }
    }
    args.push(flag.to_string());
    args.push(new_value.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::concat::VideoCodec;
    use crate::video::hw_accel::HwAccelInfo;

    #[test]
    fn recommend_sets_auto_with_resolved() {
        let p = EncodeProfile::recommend(ReencodeKind::Rotate, 18, true, Some("hevc"));
        assert_eq!(p.codec, "auto");
        assert_eq!(p.resolved_codec.as_deref(), Some("h265"));
    }

    #[test]
    fn recommend_rotate_prefers_max_quality() {
        let p = EncodeProfile::recommend(ReencodeKind::Rotate, 18, true, None);
        assert_eq!(p.preset_id, EncodePresetId::Recommended);
        assert!(p.crf <= 16);
        assert_eq!(p.sw_preset, "slow");
        assert!(p.recommend_reason.as_ref().unwrap().contains("Drehen"));
    }

    #[test]
    fn apply_preset_compat_forces_h264_1080() {
        let base = EncodeProfile::balanced(true);
        let c = EncodeProfile::apply_preset(EncodePresetId::Compat, &base);
        assert_eq!(c.codec, "h264");
        assert_eq!(c.scale_mode, ScaleMode::Fit1080p);
        assert_eq!(c.fps_mode, FpsMode::Force30);
    }

    #[test]
    fn apply_preset_fast() {
        let base = EncodeProfile::from_config_defaults(18, false, "auto");
        let f = EncodeProfile::apply_preset(EncodePresetId::Fast, &base);
        assert_eq!(f.crf, 22);
        assert_eq!(f.sw_preset, "ultrafast");
        assert!(!f.hw_accel);
    }

    #[test]
    fn to_encode_params_applies_sw_preset() {
        let hw = HwAccelInfo::software();
        let mut p = EncodeProfile::max_quality(false);
        p.sw_preset = "slow".into();
        let (enc, params) = p.to_encode_output_params(&hw, VideoCodec::H264);
        assert_eq!(enc, "libx264");
        assert!(params.windows(2).any(|w| w[0] == "-preset" && w[1] == "slow"));
        assert!(params.windows(2).any(|w| w[0] == "-crf" && w[1] == "15"));
    }

    #[test]
    fn preset_parse_aliases() {
        assert_eq!(
            EncodePresetId::parse("empfohlen"),
            Some(EncodePresetId::Recommended)
        );
        assert_eq!(EncodePresetId::parse("schnell"), Some(EncodePresetId::Fast));
    }
}
