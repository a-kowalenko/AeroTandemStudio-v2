import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Remaining ms per `persistKey` while a card is unmounted (e.g. moved panel). */
const remainingByKey = new Map<string, number>();

/**
 * Auto-dismiss with hover pause (JS timer + CSS animation-play-state).
 * Pair with `duration: Infinity` on react-hot-toast so the library does not
 * dismiss while the bar is paused.
 *
 * With `persistKey`, the remaining time survives unmount/remount.
 */
export function usePausableAutoDismiss(
  durationMs: number,
  onDismiss: () => void,
  persistKey?: string,
) {
  const [paused, setPaused] = useState(false);
  const startRemaining = useMemo(() => {
    if (!persistKey) return durationMs;
    const saved = remainingByKey.get(persistKey);
    return saved != null ? Math.min(saved, durationMs) : durationMs;
  }, [persistKey, durationMs]);
  const remainingRef = useRef(startRemaining);
  const segmentStartedRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    clearTimer();
    if (persistKey) remainingByKey.delete(persistKey);
    onDismissRef.current();
  }, [clearTimer, persistKey]);

  const armTimer = useCallback(
    (ms: number) => {
      clearTimer();
      if (ms <= 0) {
        dismiss();
        return;
      }
      remainingRef.current = ms;
      segmentStartedRef.current = Date.now();
      timerRef.current = window.setTimeout(() => dismiss(), ms);
    },
    [clearTimer, dismiss],
  );

  const captureRemaining = useCallback(() => {
    if (segmentStartedRef.current == null) return;
    const elapsed = Date.now() - segmentStartedRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    segmentStartedRef.current = null;
  }, []);

  useEffect(() => {
    dismissedRef.current = false;
    setPaused(false);
    if (durationMs <= 0) return;
    armTimer(startRemaining);
    return () => {
      clearTimer();
      if (persistKey && !dismissedRef.current) {
        captureRemaining();
        remainingByKey.set(persistKey, remainingRef.current);
      }
    };
  }, [durationMs, startRemaining, persistKey, armTimer, clearTimer, captureRemaining]);

  function onMouseEnter() {
    if (dismissedRef.current || durationMs <= 0 || paused) return;
    setPaused(true);
    clearTimer();
    captureRemaining();
  }

  function onMouseLeave() {
    if (dismissedRef.current || durationMs <= 0 || !paused) return;
    setPaused(false);
    if (remainingRef.current <= 0) {
      dismiss();
      return;
    }
    armTimer(remainingRef.current);
  }

  return {
    paused,
    /** Dismiss now (X button); runs `onDismiss` once. */
    dismiss,
    hoverProps: {
      onMouseEnter,
      onMouseLeave,
    } as const,
  };
}

/** react-hot-toast must not auto-dismiss; cards own the timer. */
export const TOAST_DURATION_MANAGED = Number.POSITIVE_INFINITY;
