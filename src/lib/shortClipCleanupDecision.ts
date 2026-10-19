/** Pure OPT-29 decision helpers (no store / Tauri deps — testable under node:test). */

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export type ShouldRemoveShortVideoInput = {
  enabled: boolean;
  maxSec: number;
  durationSecs: number | null | undefined;
  path: string;
  excludePaths?: Iterable<string>;
};

/** Parity with `maybeRemoveQrVideo` on unknown duration. */
export function shouldRemoveShortVideo(input: ShouldRemoveShortVideoInput): boolean {
  if (!input.enabled) return false;

  const key = pathKey(input.path);
  if (input.excludePaths) {
    for (const ex of input.excludePaths) {
      if (pathKey(ex) === key) return false;
    }
  }

  const duration = input.durationSecs;
  if (duration == null || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }

  const maxSec =
    input.maxSec > 0 ? input.maxSec : defaultCleanupShortVideosMaxSec();
  return duration <= maxSec;
}

export function defaultCleanupShortVideosMaxSec(): number {
  return 5;
}

export function clampCleanupShortVideosMaxSec(sec: number): number {
  if (!Number.isFinite(sec)) return defaultCleanupShortVideosMaxSec();
  return Math.min(60, Math.max(1, Math.round(sec)));
}

export function shortClipPathKey(path: string): string {
  return pathKey(path);
}
