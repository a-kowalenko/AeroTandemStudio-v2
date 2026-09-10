export type PhotoEditOrder = "crop-first" | "rotate-first";

export type NormCropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** True when a quarter-turn swaps width/height (portrait ↔ landscape). */
function isQuarterTurnSwap(degrees: number): boolean {
  const turn = normalizeDeg(degrees);
  return turn === 90 || turn === 270;
}

/** Map crop rect through CW quarter-turns of the image (matches CSS / image::rotate90). */
export function mapCropThroughRotation(
  rect: NormCropRect,
  degreesCw: number,
): NormCropRect {
  const turns = ((Math.round(degreesCw / 90) % 4) + 4) % 4;
  let next = rect;
  for (let i = 0; i < turns; i += 1) {
    // Point (x,y) → (1-y, x) under CW 90° with y-down; bbox of the rect:
    next = {
      x: 1 - next.y - next.h,
      y: next.x,
      w: next.h,
      h: next.w,
    };
  }
  return next;
}

/**
 * Layout size of the pending soft-bake preview (natural pixels before contain-fit).
 * `showCropped`: settled / committed crop window; otherwise full image.
 * `showRotate`: apply pending rotation to the display size (soft-bake truth).
 */
export function previewContentSize(
  natural: { w: number; h: number },
  crop: NormCropRect,
  order: PhotoEditOrder | null,
  degrees: number,
  showCropped: boolean,
  showRotate: boolean,
): { w: number; h: number } {
  if (!showCropped) {
    if (showRotate && isQuarterTurnSwap(degrees)) {
      return { w: natural.h, h: natural.w };
    }
    return { w: natural.w, h: natural.h };
  }

  if (order === "rotate-first" && showRotate) {
    const rw = isQuarterTurnSwap(degrees) ? natural.h : natural.w;
    const rh = isQuarterTurnSwap(degrees) ? natural.w : natural.h;
    return { w: rw * crop.w, h: rh * crop.h };
  }

  // crop-first (or crop only): crop in source space, then optional rotate
  let w = natural.w * crop.w;
  let h = natural.h * crop.h;
  if (showRotate && isQuarterTurnSwap(degrees)) {
    return { w: h, h: w };
  }
  return { w, h };
}

/** Display pixel size of the oriented (soft-bake) canvas before crop. */
export function orientedNaturalSize(
  natural: { w: number; h: number },
  degrees: number,
  showRotate: boolean,
): { w: number; h: number } {
  if (showRotate && isQuarterTurnSwap(degrees)) {
    return { w: natural.h, h: natural.w };
  }
  return { w: natural.w, h: natural.h };
}

/**
 * Soft-bake order for a draft: when rotation is involved with crop, prefer
 * rotate-first so crop lives in the visible oriented space.
 */
export function resolvePhotoEditOrder(args: {
  editOrder: PhotoEditOrder | null;
  cropPending: boolean;
  rotatePending: boolean;
}): PhotoEditOrder | null {
  const { editOrder, cropPending, rotatePending } = args;
  // Soft-bake invariant: with both tools pending, crop is in oriented space.
  if (cropPending && rotatePending) return "rotate-first";
  if (editOrder) return editOrder;
  if (cropPending) return "crop-first";
  if (rotatePending) return "rotate-first";
  return null;
}
