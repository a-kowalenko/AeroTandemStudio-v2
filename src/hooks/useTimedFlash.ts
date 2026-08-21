import { useCallback, useEffect, useRef, useState } from "react";

/** How long clear/reset buttons show the completed label while disabled. */
export const CLEAR_FLASH_MS = 1800;

export type ButtonActionPhase = "idle" | "loading" | "done";

/**
 * Button lifecycle: idle → loading (while `action` runs) → done (flash) → idle.
 * `action` returning `false` / throwing aborts back to idle without a done flash.
 */
export function useButtonActionPhase(doneMs: number = CLEAR_FLASH_MS): {
  phase: ButtonActionPhase;
  run: (action: () => boolean | Promise<boolean>) => Promise<void>;
} {
  const [phase, setPhase] = useState<ButtonActionPhase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(
    async (action: () => boolean | Promise<boolean>) => {
      if (phaseRef.current !== "idle") return;
      clearTimer();
      setPhase("loading");
      let ok = false;
      try {
        ok = await action();
      } catch {
        setPhase("idle");
        return;
      }
      if (!ok) {
        setPhase("idle");
        return;
      }
      setPhase("done");
      timerRef.current = window.setTimeout(() => {
        setPhase("idle");
        timerRef.current = null;
      }, doneMs);
    },
    [clearTimer, doneMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { phase, run };
}

/**
 * Same as {@link useButtonActionPhase}, but scoped to a kind (e.g. video/foto tab).
 */
export function useButtonActionPhaseKind<T extends string>(
  doneMs: number = CLEAR_FLASH_MS,
): {
  phase: { kind: T; state: "loading" | "done" } | null;
  run: (kind: T, action: () => boolean | Promise<boolean>) => Promise<void>;
} {
  const [phase, setPhase] = useState<{
    kind: T;
    state: "loading" | "done";
  } | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(
    async (kind: T, action: () => boolean | Promise<boolean>) => {
      if (phaseRef.current != null) return;
      clearTimer();
      setPhase({ kind, state: "loading" });
      let ok = false;
      try {
        ok = await action();
      } catch {
        setPhase(null);
        return;
      }
      if (!ok) {
        setPhase(null);
        return;
      }
      setPhase({ kind, state: "done" });
      timerRef.current = window.setTimeout(() => {
        setPhase(null);
        timerRef.current = null;
      }, doneMs);
    },
    [clearTimer, doneMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { phase, run };
}
