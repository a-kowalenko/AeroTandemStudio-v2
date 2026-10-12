/** Pure helpers: settle sibling QR scan chrome after a hit (lookup may run in parallel). */

export type QrSettlePhase = "pending" | "active" | "done" | "hit" | "removed";

/** Pending/active → done; optional hit key stays `hit` unless already `removed`. */
export function settleByPathAfterHit(
  byPath: Record<string, QrSettlePhase>,
  hitKey?: string | null,
): Record<string, QrSettlePhase> {
  const hit = hitKey?.trim() ? hitKey : null;
  const next: Record<string, QrSettlePhase> = { ...byPath };
  for (const key of Object.keys(next)) {
    const phase = next[key];
    if (phase === "removed" || phase === "done") continue;
    if (hit && key === hit) {
      next[key] = "hit";
      continue;
    }
    if (phase === "hit") {
      // Another path already marked hit — leave it; siblings still settle.
      continue;
    }
    next[key] = "done";
  }
  if (hit && hit in next && next[hit] !== "removed") {
    next[hit] = "hit";
  }
  return next;
}

/** Keep only hit/removed tiles once the batch scan has a carrier. */
export function retainHitRemovedLiveFrames<T extends { tone: string }>(
  frames: readonly T[],
): T[] {
  return frames.filter((f) => f.tone === "hit" || f.tone === "removed");
}

/** True while a carrier thumb is still on screen (hit / removed leave / scan). */
export function hasQrCarrierLiveThumb(
  frames: readonly { tone: string }[],
): boolean {
  return frames.some(
    (f) => f.tone === "hit" || f.tone === "removed" || f.tone === "scan",
  );
}
