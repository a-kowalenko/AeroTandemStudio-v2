import type { CSSProperties } from "react";

/**
 * Layout helpers for CSS preview rotation (90° swaps landscape ↔ portrait).
 * Pixel apply still happens in Rust; this only fixes the edit-dialog preview.
 *
 * CSS `rotate()` must keep the continuous signed angle (…, −90, 0, 90, 180, 270, 360, …)
 * so transitions take the short path. Never feed 0–359 normalized values into `rotate()`
 * across a wrap (0→−90 must not become 0→270; 270→360 must not become 270→0).
 */

export function normalizePreviewRotateDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** True when apply/commit would change pixels (360 ≡ 0). */
export function hasNetPreviewRotate(degrees: number): boolean {
  return normalizePreviewRotateDeg(degrees) !== 0;
}

/** Landed on a full turn (±360, ±720…) — snap to 0 without animating. */
export function isFullTurnPreviewRotate(degrees: number): boolean {
  return degrees !== 0 && degrees % 360 === 0;
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

/**
 * @param degrees Continuous signed angle, or `null` to disable rotate preview layout.
 *                `0` still emits `rotate(0deg)` so the next ±90° takes the short path.
 */
export function previewRotateMediaStyle(
  degrees: number | null,
): CSSProperties | undefined {
  if (degrees == null) return undefined;
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
 * Static thumb in a fixed 16:9 tile. Quarter turns are letterboxed (portrait result
 * fits the tile height); pre-rotate box is 56.25% × 56.25% of the tile.
 */
export function previewRotateThumbStyle(degrees: number): CSSProperties | undefined {
  const turn = normalizePreviewRotateDeg(degrees);
  if (turn === 0) return undefined;
  if (turn === 180) return { transform: "rotate(180deg)" };
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: "56.25%",
    height: "56.25%",
    objectFit: "contain",
    transform: `translate(-50%, -50%) rotate(${turn}deg)`,
  };
}

/**
 * Cover-fit media (filmstrip tile, QR live tile) rotated inside a clipped box.
 * Quarter turns size the pre-rotate box with container units (cqh × cqw), so the
 * container needs `container-type: size` — returned as `container`.
 */
export function previewRotateCoverStyles(degrees: number): {
  container?: CSSProperties;
  media?: CSSProperties;
} {
  const turn = normalizePreviewRotateDeg(degrees);
  if (turn === 0) return {};
  if (turn === 180) return { media: { transform: "rotate(180deg)" } };
  return {
    container: { containerType: "size" },
    media: {
      position: "absolute",
      left: "50%",
      top: "50%",
      right: "auto",
      bottom: "auto",
      width: "100cqh",
      height: "100cqw",
      transform: `translate(-50%, -50%) rotate(${turn}deg)`,
    },
  };
}

/**
 * CSS rotate when the parent frame is already sized to the *post*-rotation aspect
 * (e.g. PhotoEditor contain-box). Uses px so Tailwind w/h-full cannot fight percentages.
 *
 * @param degrees Continuous signed angle — including 0 (always emits rotate).
 */
export function previewRotateMediaStyleInFrame(
  degrees: number,
  frameW: number,
  frameH: number,
): CSSProperties {
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
