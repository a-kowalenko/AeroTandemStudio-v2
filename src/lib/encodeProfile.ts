import type { EncodePresetId, EncodeProfile } from "./tauri";

/** Display label for codec preference, e.g. `auto (H.264)`. */
export function formatCodecLabel(profile: EncodeProfile): string {
  if (profile.codec === "auto") {
    const resolved = normalizeResolved(profile.resolved_codec);
    return resolved ? `auto (${resolved})` : "auto";
  }
  if (profile.codec === "h264") return "H.264";
  if (profile.codec === "h265") return "H.265";
  return profile.codec;
}

/** Select item label for the `auto` option. */
export function formatAutoCodecOption(profile: EncodeProfile): string {
  const resolved = normalizeResolved(profile.resolved_codec);
  return resolved ? `auto (${resolved})` : "auto";
}

function normalizeResolved(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase();
  if (n === "h264" || n === "avc" || n === "avc1") return "H.264";
  if (n === "h265" || n === "hevc" || n === "hvc1") return "H.265";
  return null;
}

/** Mirror of Rust `EncodeProfile::apply_preset` for the confirm dialog. */
export function applyEncodePreset(
  preset: EncodePresetId,
  base: EncodeProfile,
): EncodeProfile {
  const hw = base.hw_accel;
  const resolved = base.resolved_codec ?? null;
  switch (preset) {
    case "recommended": {
      const isRotate = (base.recommend_reason ?? "").includes("Drehen");
      if (isRotate) {
        return {
          ...maxQuality(hw),
          preset_id: "recommended",
          codec:
            base.codec === "h264" || base.codec === "h265" ? base.codec : "auto",
          resolved_codec: resolved,
          recommend_reason: base.recommend_reason,
        };
      }
      return {
        ...balanced(hw),
        preset_id: "recommended",
        crf: base.crf,
        codec:
          base.codec === "h264" || base.codec === "h265" ? base.codec : "auto",
        resolved_codec: resolved,
        recommend_reason: base.recommend_reason,
      };
    }
    case "max_quality":
      return {
        ...maxQuality(hw),
        codec:
          base.codec === "h264" || base.codec === "h265" ? base.codec : "auto",
        resolved_codec: resolved,
      };
    case "balanced":
      return {
        ...balanced(hw),
        codec:
          base.codec === "h264" || base.codec === "h265" ? base.codec : "auto",
        resolved_codec: resolved,
      };
    case "fast":
      return {
        ...fast(hw),
        codec:
          base.codec === "h264" || base.codec === "h265" ? base.codec : "auto",
        resolved_codec: resolved,
      };
    case "compat":
      return compat(hw);
    case "custom":
      return { ...base, preset_id: "custom", recommend_reason: null };
    default:
      return {
        ...balanced(hw),
        codec: "auto",
        resolved_codec: resolved,
      };
  }
}

function balanced(hw: boolean): EncodeProfile {
  return {
    preset_id: "balanced",
    codec: "auto",
    resolved_codec: null,
    crf: 18,
    sw_preset: "veryfast",
    nvenc_preset: "p4",
    hw_accel: hw,
    scale_mode: "source",
    fps_mode: "source",
    recommend_reason: null,
  };
}

function maxQuality(hw: boolean): EncodeProfile {
  return {
    preset_id: "max_quality",
    codec: "auto",
    resolved_codec: null,
    crf: 15,
    sw_preset: "slow",
    nvenc_preset: "p6",
    hw_accel: hw,
    scale_mode: "source",
    fps_mode: "source",
    recommend_reason: null,
  };
}

function fast(hw: boolean): EncodeProfile {
  return {
    preset_id: "fast",
    codec: "auto",
    resolved_codec: null,
    crf: 22,
    sw_preset: "ultrafast",
    nvenc_preset: "p2",
    hw_accel: hw,
    scale_mode: "source",
    fps_mode: "source",
    recommend_reason: null,
  };
}

function compat(hw: boolean): EncodeProfile {
  return {
    preset_id: "compat",
    codec: "h264",
    resolved_codec: "h264",
    crf: 18,
    sw_preset: "medium",
    nvenc_preset: "p4",
    hw_accel: hw,
    scale_mode: "fit_1080p",
    fps_mode: "force_30",
    recommend_reason: null,
  };
}

export function defaultEncodeProfile(): EncodeProfile {
  return balanced(true);
}
