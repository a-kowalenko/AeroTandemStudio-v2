/** How long a non-terminal thumb tone must stay before it is painted. */
export const QR_LIVE_TONE_SETTLE_MS = 200;

/** Miss tiles that were already open fade out for this long, then leave. */
export const QR_LIVE_MISS_FADE_MS = 200;

/** On-screen live thumbs. Hit and removal stay; older scan/miss frames drop first. */
export const QR_LIVE_FRAME_CAP = 6;

export type QrLivePresentTone = "scan" | "hit" | "miss" | "removed";

export type QrLivePresentFrame = {
  key: string;
  mediaPath: string;
  livePath: string;
  gen: number;
  tone: QrLivePresentTone;
};

export function isTerminalQrLiveTone(tone: QrLivePresentTone): boolean {
  return tone === "miss" || tone === "removed";
}

/**
 * What the tile should paint.
 *
 * `miss` and `removed` commit immediately. A following `hit` commits only
 * after it has been stable for `settleMs`, so a faster removal replaces it
 * before it appears. Nothing is queued for later playback.
 *
 * `immediateScan` paints the first `scan` at once. Video clips stay on that
 * tone for the whole pass, so holding it only delays the thumb.
 */
export function presentedQrLiveTone(
  shown: QrLivePresentTone | null,
  fact: QrLivePresentTone,
  factAgeMs: number,
  settleMs = QR_LIVE_TONE_SETTLE_MS,
  immediateScan = false,
): QrLivePresentTone | null {
  if (isTerminalQrLiveTone(fact)) return fact;
  // First paint: show whatever is already true. A later hit still settles.
  if (immediateScan && shown === null) return fact;
  if (immediateScan && fact === "scan" && shown === "scan") return "scan";
  if (factAgeMs >= settleMs) return fact;
  return shown;
}

/** Clips whose scan has started and that do not have a decode frame yet. */
export function videoPlaceholderFrames(
  scanOrder: readonly string[],
  byPath: Readonly<Record<string, string>>,
  liveKeys: ReadonlySet<string>,
  mediaPathFor: (key: string) => string,
): QrLivePresentFrame[] {
  const out: QrLivePresentFrame[] = [];
  for (const key of scanOrder) {
    if (!key || liveKeys.has(key)) continue;
    const phase = byPath[key];
    if (phase !== "active" && phase !== "hit") continue;
    out.push({
      key,
      mediaPath: mediaPathFor(key) || key,
      livePath: "",
      gen: 0,
      tone: phase === "hit" ? "hit" : "scan",
    });
  }
  return out;
}

export function capQrLiveFrames<T extends { key: string; tone: string }>(
  frames: readonly T[],
  max = QR_LIVE_FRAME_CAP,
): T[] {
  if (frames.length <= max) return [...frames];
  const pinned = frames.filter((f) => f.tone === "hit" || f.tone === "removed");
  const rest = frames.filter((f) => f.tone !== "hit" && f.tone !== "removed");
  const room = Math.max(0, max - pinned.length);
  const keptRest = new Set(rest.slice(-room).map((f) => f.key));
  const pinnedKeys = new Set(pinned.map((f) => f.key));
  return frames.filter((f) => pinnedKeys.has(f.key) || keptRest.has(f.key));
}

/** Keep the current thumbs. The hit stays on its image and only changes tone. */
export function retainLiveFramesForFollowup(
  frames: readonly QrLivePresentFrame[],
  hitKey: string,
  hitPath: string,
): QrLivePresentFrame[] {
  const next = frames.map((f) =>
    f.key === hitKey ? { ...f, tone: "hit" as const } : { ...f },
  );
  if (hitKey && hitPath.trim() && !next.some((f) => f.key === hitKey)) {
    next.push({
      key: hitKey,
      mediaPath: hitPath,
      livePath: hitPath,
      gen: 1,
      tone: "hit",
    });
  }
  return capQrLiveFrames(next);
}

/** Paint carriers red in place. Same image generation, same tiles. */
export function markLiveFramesRemoved(
  frames: readonly QrLivePresentFrame[],
  keys: ReadonlySet<string>,
): QrLivePresentFrame[] {
  return frames.map((f) => (keys.has(f.key) ? { ...f, tone: "removed" } : f));
}
