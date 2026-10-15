/** Shared-element handoff: QR strip thumb → booking-lookup thumb slot. */

/** Brief pause at strip rect before glide (lookup stays compact). */
export const QR_LOOKUP_THUMB_FLIGHT_HOLD_MS = 100;

/** @deprecated alias — hold only, not lookup expand wait */
export const QR_LOOKUP_THUMB_FLIGHT_SETTLE_MS = QR_LOOKUP_THUMB_FLIGHT_HOLD_MS;

/** Shared-element glide strip → compact lookup thumb slot. */
export const QR_LOOKUP_THUMB_FLIGHT_MS = 500;

export const QR_LOOKUP_THUMB_FLIGHT_EASE =
  "cubic-bezier(0.33, 1, 0.42, 1)";

export type QrLookupThumbFlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type QrLookupThumbFlightState = {
  phase: "flying";
  frameKey: string;
  path: string;
  gen: number;
  mediaPath: string;
  start: QrLookupThumbFlightRect;
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function rectFromDom(el: Element | null | undefined): QrLookupThumbFlightRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 2 && r.height > 2)) return null;
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  };
}

/** FLIP deltas: map start box onto dest box via translate + scale. */
export function flightTransform(
  start: QrLookupThumbFlightRect,
  dest: QrLookupThumbFlightRect,
): { dx: number; dy: number; scaleX: number; scaleY: number } {
  const scaleX = start.width > 0 ? dest.width / start.width : 1;
  const scaleY = start.height > 0 ? dest.height / start.height : 1;
  const dx = dest.left + dest.width / 2 - (start.left + start.width / 2);
  const dy = dest.top + dest.height / 2 - (start.top + start.height / 2);
  return { dx, dy, scaleX, scaleY };
}
