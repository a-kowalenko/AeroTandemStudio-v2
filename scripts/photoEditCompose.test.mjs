import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapCropThroughRotation,
  orientedNaturalSize,
  previewContentSize,
  resolvePhotoEditOrder,
} from "../src/lib/photoEditCompose.ts";

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const NATURAL = { w: 4000, h: 3000 };

describe("mapCropThroughRotation", () => {
  it("is identity at 0° / 360°", () => {
    const rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
    assert.deepEqual(mapCropThroughRotation(rect, 0), rect);
    assert.deepEqual(mapCropThroughRotation(rect, 360), rect);
  });

  it("maps CW 90° and round-trips 360°", () => {
    const rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
    const once = mapCropThroughRotation(rect, 90);
    // CW: (x,y,w,h) → (1-y-h, x, h, w)
    assert.deepEqual(once, {
      x: 1 - 0.2 - 0.3,
      y: 0.1,
      w: 0.3,
      h: 0.5,
    });
    // Left half of landscape → top half after CW 90
    assert.deepEqual(mapCropThroughRotation({ x: 0, y: 0, w: 0.5, h: 1 }, 90), {
      x: 0,
      y: 0,
      w: 1,
      h: 0.5,
    });
    const four = [90, 90, 90, 90].reduce(
      (r, d) => mapCropThroughRotation(r, d),
      rect,
    );
    assert.ok(Math.abs(four.x - rect.x) < 1e-9);
    assert.ok(Math.abs(four.y - rect.y) < 1e-9);
    assert.ok(Math.abs(four.w - rect.w) < 1e-9);
    assert.ok(Math.abs(four.h - rect.h) < 1e-9);
  });
});

describe("previewContentSize soft-bake", () => {
  it("shows swapped full size when rotated and not cropped (crop-mode truth)", () => {
    const size = previewContentSize(NATURAL, FULL, "rotate-first", 90, false, true);
    assert.deepEqual(size, { w: 3000, h: 4000 });
  });

  it("ignores rotation when showRotate is false", () => {
    const size = previewContentSize(NATURAL, FULL, "rotate-first", 90, false, false);
    assert.deepEqual(size, { w: 4000, h: 3000 });
  });

  it("rotate-first settled crop uses oriented dimensions", () => {
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.4 };
    const size = previewContentSize(
      NATURAL,
      crop,
      "rotate-first",
      90,
      true,
      true,
    );
    // oriented full = 3000×4000, then * crop
    assert.deepEqual(size, { w: 3000 * 0.5, h: 4000 * 0.4 });
  });

  it("crop-first settled then rotate swaps crop window", () => {
    const crop = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const size = previewContentSize(
      NATURAL,
      crop,
      "crop-first",
      90,
      true,
      true,
    );
    // source crop 2000×1500 → after 90° swap → 1500×2000
    assert.deepEqual(size, { w: 1500, h: 2000 });
  });
});

describe("orientedNaturalSize", () => {
  it("swaps on quarter turns when showing rotate", () => {
    assert.deepEqual(orientedNaturalSize(NATURAL, 90, true), {
      w: 3000,
      h: 4000,
    });
    assert.deepEqual(orientedNaturalSize(NATURAL, 180, true), NATURAL);
    assert.deepEqual(orientedNaturalSize(NATURAL, 90, false), NATURAL);
  });
});

describe("resolvePhotoEditOrder", () => {
  it("forces rotate-first when both tools are pending (soft-bake)", () => {
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: "crop-first",
        cropPending: true,
        rotatePending: true,
      }),
      "rotate-first",
    );
  });

  it("keeps locked editOrder when only one tool is pending", () => {
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: "crop-first",
        cropPending: true,
        rotatePending: false,
      }),
      "crop-first",
    );
  });

  it("defaults both-pending to rotate-first for soft-bake", () => {
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: null,
        cropPending: true,
        rotatePending: true,
      }),
      "rotate-first",
    );
  });

  it("resolves single pending tools", () => {
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: null,
        cropPending: true,
        rotatePending: false,
      }),
      "crop-first",
    );
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: null,
        cropPending: false,
        rotatePending: true,
      }),
      "rotate-first",
    );
    assert.equal(
      resolvePhotoEditOrder({
        editOrder: null,
        cropPending: false,
        rotatePending: false,
      }),
      null,
    );
  });
});
