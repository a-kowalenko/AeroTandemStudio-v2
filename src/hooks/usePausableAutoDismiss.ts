import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
} from "react";

/** Remaining ms per `persistKey` while a card is unmounted (e.g. moved panel). */
const remainingByKey = new Map<string, number>();

function liveRemaining(
  remaining: number,
  segmentStarted: number | null,
): number {
  if (segmentStarted == null) return remaining;
  return Math.max(0, remaining - (Date.now() - segmentStarted));
}

/**
 * Auto-dismiss with hover/focus-within pause (JS timer + CSS animation-play-state).
 * Pair with `duration: Infinity` on react-hot-toast so the library does not
 * dismiss while the bar is paused.
 *
 * With `persistKey`, the remaining time survives unmount/remount.
 */
export function usePausableAutoDismiss(
  durationMs: number,
  onDismiss: () => void,
  persistKey?: string,
  resetKey?: string | number,
) {
  const [paused, setPaused] = useState(false);
  const startRemaining = useMemo(() => {
    if (!persistKey) return durationMs;
    const saved = remainingByKey.get(persistKey);
    return saved != null ? Math.min(saved, durationMs) : durationMs;
  }, [persistKey, durationMs]);
  const [remainingMs, setRemainingMs] = useState(startRemaining);
  const remainingRef = useRef(startRemaining);
  const segmentStartedRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const dismissedRef = useRef(false);
  const pausedRef = useRef(false);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
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
      setRemainingMs(ms);
      timerRef.current = window.setTimeout(() => dismiss(), ms);
    },
    [clearTimer, dismiss],
  );

  const captureRemaining = useCallback(() => {
    if (segmentStartedRef.current == null) return;
    const elapsed = Date.now() - segmentStartedRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    segmentStartedRef.current = null;
    setRemainingMs(remainingRef.current);
  }, []);

  const applyHold = useCallback(() => {
    if (dismissedRef.current || durationMs <= 0) return;
    const hold = hoverRef.current || focusRef.current;
    if (hold === pausedRef.current) return;
    pausedRef.current = hold;
    setPaused(hold);
    if (hold) {
      clearTimer();
      captureRemaining();
      return;
    }
    if (remainingRef.current <= 0) {
      dismiss();
      return;
    }
    armTimer(remainingRef.current);
  }, [armTimer, captureRemaining, clearTimer, dismiss, durationMs]);

  useEffect(() => {
    dismissedRef.current = false;
    pausedRef.current = false;
    hoverRef.current = false;
    focusRef.current = false;
    setPaused(false);
    remainingRef.current = startRemaining;
    setRemainingMs(startRemaining);
    if (durationMs <= 0) return;
    armTimer(startRemaining);
    return () => {
      clearTimer();
      if (persistKey && !dismissedRef.current) {
        captureRemaining();
        remainingByKey.set(persistKey, remainingRef.current);
      }
    };
  }, [
    durationMs,
    startRemaining,
    persistKey,
    resetKey,
    armTimer,
    clearTimer,
    captureRemaining,
  ]);

  useEffect(() => {
    if (durationMs <= 0 || paused) return;
    const id = window.setInterval(() => {
      setRemainingMs(
        liveRemaining(remainingRef.current, segmentStartedRef.current),
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [durationMs, paused]);

  function onMouseEnter() {
    hoverRef.current = true;
    applyHold();
  }

  function onMouseLeave() {
    hoverRef.current = false;
    applyHold();
  }

  function onFocusCapture() {
    focusRef.current = true;
    applyHold();
  }

  function onBlurCapture(event: FocusEvent<HTMLElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    focusRef.current = false;
    applyHold();
  }

  const hoverProps = {
    onMouseEnter,
    onMouseLeave,
  } as const;

  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

  return {
    paused,
    remainingMs,
    remainingSec,
    /** Dismiss now (X button); runs `onDismiss` once. */
    dismiss,
    hoverProps,
    /** Hover + keyboard focus-within (dialogs). */
    pauseProps: {
      ...hoverProps,
      onFocusCapture,
      onBlurCapture,
    } as const,
  };
}

/** react-hot-toast must not auto-dismiss; cards own the timer. */
export const TOAST_DURATION_MANAGED = Number.POSITIVE_INFINITY;
