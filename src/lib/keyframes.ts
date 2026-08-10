/** Last keyframe at or before `maxSecs`. */
export function keyframeAtOrBefore(
  times: number[],
  maxSecs: number,
): number | null {
  const ceil = maxSecs + 1e-6;
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i]! <= ceil) return times[i]!;
  }
  return null;
}

/** First keyframe at or after `minSecs`. */
export function keyframeAtOrAfter(
  times: number[],
  minSecs: number,
): number | null {
  const floor = minSecs - 1e-6;
  for (const t of times) {
    if (t >= floor) return t;
  }
  return null;
}

/** Nearest keyframe to `targetSecs`. */
export function nearestKeyframe(
  times: number[],
  targetSecs: number,
): number | null {
  if (times.length === 0) return null;
  let best = times[0]!;
  let bestDist = Math.abs(best - targetSecs);
  for (let i = 1; i < times.length; i++) {
    const t = times[i]!;
    const d = Math.abs(t - targetSecs);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Snap keep-range to stream-copy-friendly keyframes:
 * start floored, end ceiled. Guarantees end > start when possible.
 */
export function snapTrimRangeToKeyframes(
  times: number[],
  startSecs: number,
  endSecs: number,
): { startSecs: number; endSecs: number } {
  let start = Math.max(0, startSecs);
  let end = Math.max(start, endSecs);
  if (times.length === 0) return { startSecs: start, endSecs: end };

  const floored = keyframeAtOrBefore(times, start);
  if (floored != null) start = floored;
  else {
    const next = keyframeAtOrAfter(times, start);
    if (next != null) start = next;
  }

  const ceiled = keyframeAtOrAfter(times, end);
  if (ceiled != null) end = ceiled;
  else {
    const prev = keyframeAtOrBefore(times, end);
    if (prev != null) end = prev;
  }

  if (end <= start) {
    const next = times.find((t) => t > start + 1e-6);
    if (next != null) end = next;
  }

  if (end <= start) {
    return {
      startSecs: Math.max(0, startSecs),
      endSecs: Math.max(Math.max(0, startSecs) + 0.1, endSecs),
    };
  }
  return { startSecs: start, endSecs: end };
}
