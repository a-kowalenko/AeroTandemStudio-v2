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

/**
 * CSS rotate when the parent frame is already sized to the *post*-rotation aspect
 * (e.g. PhotoEditor contain-box). Uses px so Tailwind w/h-full cannot fight percentages.
 */
export function previewRotateMediaStyleInFrame(
  degrees: number,
  frameW: number,
  frameH: number,
): CSSProperties | undefined {
  if (degrees === 0) return undefined;
  if (!(frameW > 0 && frameH > 0)) {
    return { transform: `rotate(${degrees}deg)` };
  }
  const swapped = isQuarterTurnSwap(degrees);
  // Pre-rotate box = frame with axes swapped when quarter-turn.
  const mediaW = swapped ? frameH : frameW;
  const mediaH = swapped ? frameW : frameH;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: mediaW,
    height: mediaH,
    maxWidth: "none",
    maxHeight: "none",
    objectFit: "fill",
    transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
  };
}
