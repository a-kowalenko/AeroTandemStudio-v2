import type { CSSProperties } from "react";

/**
 * Layout helpers for CSS preview rotation (90° swaps landscape ↔ portrait).
 * Pixel apply still happens in Rust; this only fixes the edit-dialog preview.
 */

export function normalizePreviewRotateDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** True when a quarter-turn swaps width/height (portrait ↔ landscape). */
export function isQuarterTurnSwap(degrees: number): boolean {
  const turn = normalizePreviewRotateDeg(degrees);
  return turn === 90 || turn === 270;
}

/**
 * Stage box: 16:9 when upright/180°, 9:16 when 90°/270°.
 * Media wrapper: sized so after rotate() it fills the stage without clipping.
 */
export function previewRotateStageClass(degrees: number): string {
  return isQuarterTurnSwap(degrees)
    ? "aspect-[9/16] mx-auto w-full max-w-sm max-h-[min(70vh,28rem)]"
    : "aspect-video w-full";
}

export function previewRotateMediaStyle(
  degrees: number,
): CSSProperties | undefined {
  // Keep the continuous signed angle for CSS `rotate()` so transitions take the
  // short path (0→−90, not 0→270; 270→360, not 270→0). Layout still uses the
  // normalized quarter-turn.
  if (degrees === 0) return undefined;
  const swapped = isQuarterTurnSwap(degrees);
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    // Portrait stage W×(16/9 W): pre-rotate box is (16/9 W)×W = 177.78% × 56.25% of stage.
    width: swapped ? "177.7778%" : "100%",
    height: swapped ? "56.25%" : "100%",
    transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
  };
}
