/** Pick a still image for the expanded booking-lookup row. */

import { normalizeMediaPath } from "@/store/qrScanStore";

export type QrLookupThumbPickFrame = {
  key: string;
  mediaPath: string;
  livePath: string;
  gen: number;
  tone: string;
};

export type QrLookupThumbPickPreview = {
  path: string;
  width?: number;
  height?: number;
  spotlight: { x: number; y: number; size: number } | null;
};

export type QrLookupThumbPick = {
  path: string;
  gen: number;
  spotlight: { x: number; y: number; size: number } | null;
  mediaPath: string;
  /** width / height; matches strip tile when known. */
  aspectRatio: number;
};

/** Strip-style 16:9 default when size unknown. */
export const QR_LOOKUP_THUMB_DEFAULT_ASPECT = 16 / 9;

export function thumbAspectRatioFromSize(width: number, height: number): number {
  if (!(width > 0 && height > 0)) return QR_LOOKUP_THUMB_DEFAULT_ASPECT;
  const raw = width / height;
  return Math.min(2.5, Math.max(0.45, raw));
}

export function thumbAspectRatioFromRect(rect: {
  width: number;
  height: number;
}): number {
  return thumbAspectRatioFromSize(rect.width, rect.height);
}

/**
 * Prefer the QR hit preview (stable after carrier cleanup), else the live
 * hit/removed decode frame still on the strip.
 */
export function pickQrLookupThumb(opts: {
  frames: readonly QrLookupThumbPickFrame[];
  sourcePath?: string | null;
  preview?: QrLookupThumbPickPreview | null;
}): QrLookupThumbPick | null {
  const previewPath = opts.preview?.path?.trim() ?? "";
  const source = (opts.sourcePath ?? "").trim();
  if (previewPath) {
    const pw = opts.preview?.width ?? 0;
    const ph = opts.preview?.height ?? 0;
    return {
      path: previewPath,
      gen: 0,
      spotlight: opts.preview?.spotlight ?? null,
      mediaPath: source,
      aspectRatio: thumbAspectRatioFromSize(pw, ph),
    };
  }

  const key = source ? normalizeMediaPath(source) : "";
  const hitOrRemoved = opts.frames.filter(
    (f) => f.tone === "hit" || f.tone === "removed",
  );
  const preferred =
    (key ? hitOrRemoved.find((f) => f.key === key) : undefined) ??
    hitOrRemoved.find((f) => f.tone === "hit") ??
    hitOrRemoved[0];
  const path = preferred?.livePath?.trim() ?? "";
  if (!path || !preferred) return null;
  return {
    path,
    gen: Math.max(0, Math.floor(preferred.gen)),
    spotlight: null,
    mediaPath: preferred.mediaPath.trim() || source,
    aspectRatio: QR_LOOKUP_THUMB_DEFAULT_ASPECT,
  };
}
