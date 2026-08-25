/** Soft low-media thresholds before create (Phase 29). Keep in sync with `video/low_media.rs`. */

import type { Kunde } from "./tauri";

/** Warn when booked video product has this many videos or fewer. */
export const LOW_MEDIA_VIDEO_MAX = 1;
/** Warn when booked photo product has fewer than this many photos. */
export const LOW_MEDIA_PHOTO_MIN = 20;

export type LowMediaReason = "video" | "photos";

export type LowMediaWarnInput = {
  kunde: Pick<
    Kunde,
    "handcam_video" | "outside_video" | "handcam_foto" | "outside_foto"
  >;
  videoCount: number;
  photoCount: number;
};

export type LowMediaWarnResult = {
  warn: boolean;
  reasons: LowMediaReason[];
  videoCount: number;
  photoCount: number;
};

export function needsVideoProduct(
  kunde: Pick<Kunde, "handcam_video" | "outside_video">,
): boolean {
  return Boolean(kunde.handcam_video || kunde.outside_video);
}

export function needsFotoProduct(
  kunde: Pick<Kunde, "handcam_foto" | "outside_foto">,
): boolean {
  return Boolean(kunde.handcam_foto || kunde.outside_foto);
}

/**
 * Product-scoped soft check: only booked media kinds are evaluated.
 * Independent reasons (OR per product), never a hard validation error.
 */
export function shouldWarnLowMedia(input: LowMediaWarnInput): LowMediaWarnResult {
  const reasons: LowMediaReason[] = [];

  if (
    needsVideoProduct(input.kunde) &&
    input.videoCount <= LOW_MEDIA_VIDEO_MAX
  ) {
    reasons.push("video");
  }
  if (
    needsFotoProduct(input.kunde) &&
    input.photoCount < LOW_MEDIA_PHOTO_MIN
  ) {
    reasons.push("photos");
  }

  return {
    warn: reasons.length > 0,
    reasons,
    videoCount: input.videoCount,
    photoCount: input.photoCount,
  };
}

/** Stable signature so we warn once per Vorgang until media/products change. */
export function lowMediaSignature(input: LowMediaWarnInput): string {
  return [
    needsVideoProduct(input.kunde) ? "1" : "0",
    needsFotoProduct(input.kunde) ? "1" : "0",
    String(input.videoCount),
    String(input.photoCount),
  ].join("|");
}

export type LowMediaConfirmState = {
  reasons: LowMediaReason[];
  videoCount: number;
  photoCount: number;
  /** Upload follows create when config says so — for dialog hint copy. */
  uploadToServer: boolean;
};
