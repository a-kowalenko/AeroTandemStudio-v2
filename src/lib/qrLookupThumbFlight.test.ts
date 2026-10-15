import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flightTransform } from "./qrLookupThumbFlight.ts";

describe("flightTransform", () => {
  it("maps start center onto dest center with scale", () => {
    const t = flightTransform(
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 200, top: 50, width: 50, height: 50 },
    );
    assert.equal(t.scaleX, 0.5);
    assert.equal(t.scaleY, 0.5);
    // start center 50,50 → dest center 225,75 → dx=175, dy=25
    assert.equal(t.dx, 175);
    assert.equal(t.dy, 25);
  });
});
