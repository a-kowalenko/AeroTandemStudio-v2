import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auto-dismiss with hover pause (JS timer + CSS animation-play-state).
 * Pair with `duration: Infinity` on react-hot-toast so the library does not
 * dismiss while the bar is paused.
 */
export function usePausableAutoDismiss(
  durationMs: number,
  onDismiss: () => void,
) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);
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
    onDismissRef.current();
  }, [clearTimer]);

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

  useEffect(() => {
    dismissedRef.current = false;
    setPaused(false);
    if (durationMs <= 0) return;
    armTimer(durationMs);
    return clearTimer;
  }, [durationMs, armTimer, clearTimer]);

  function captureRemaining() {
    if (segmentStartedRef.current == null) return;
    const elapsed = Date.now() - segmentStartedRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    segmentStartedRef.current = null;
  }

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
    hoverProps: {
      onMouseEnter,
      onMouseLeave,
    } as const,
  };
}

/** react-hot-toast must not auto-dismiss; cards own the timer. */
export const TOAST_DURATION_MANAGED = Number.POSITIVE_INFINITY;
