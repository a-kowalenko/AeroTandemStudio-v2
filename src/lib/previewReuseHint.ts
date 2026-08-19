import type { TFunction } from "i18next";
import type { PreviewReusePlan } from "../store/previewCacheStore";

const REASON_KEYS = {
  no_preview: "create.encode.reasonNoPreview",
  clips_changed: "create.encode.reasonClipsChanged",
  form_changed: "create.encode.reasonFormChanged",
  encoding_changed: "create.encode.reasonEncodingChanged",
} as const;

export type PreviewReuseHintTone = "reuse" | "encode";

export type PreviewReuseHint = {
  tone: PreviewReuseHintTone;
  message: string;
  title?: string;
};

/** User-facing hint for create encode path (preview reuse vs full encode). */
export function formatPreviewReuseHint(
  t: TFunction,
  plan: PreviewReusePlan,
): PreviewReuseHint {
  if (plan.canReuse) {
    return {
      tone: "reuse",
      message: t("create.encode.reusePreview"),
      title: t("create.encode.reusePreviewTitle"),
    };
  }
  return {
    tone: "encode",
    message: t("create.encode.reencodeBecause", {
      reason: t(REASON_KEYS[plan.reason]),
    }),
    title: t("create.encode.reencodeTitle"),
  };
}
