import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldResetOverallProgressPercent } from "./progressPercentReset.ts";

describe("shouldResetOverallProgressPercent", () => {
  it("resets on intro-phase entry statuses", () => {
    assert.equal(
      shouldResetOverallProgressPercent("Kodiere Intro+Video (kompatibel)…"),
      true,
    );
    assert.equal(
      shouldResetOverallProgressPercent("Kodiere Intro+Video (Audio-Copy)…"),
      true,
    );
    assert.equal(shouldResetOverallProgressPercent("Erstelle Intro…"), true);
    assert.equal(
      shouldResetOverallProgressPercent("Füge Intro und Video zusammen…"),
      true,
    );
    assert.equal(
      shouldResetOverallProgressPercent(
        "Kodiere Intro+Video neu: codec mismatch",
      ),
      true,
    );
    assert.equal(
      shouldResetOverallProgressPercent(
        "Kodiere neu auf H.264 (Ziel-Codec)",
      ),
      true,
    );
  });

  it("resets at body-join step start", () => {
    assert.equal(
      shouldResetOverallProgressPercent("Füge Clips zusammen…"),
      true,
    );
    assert.equal(
      shouldResetOverallProgressPercent("Bereite Videoclips vor…"),
      true,
    );
  });

  it("does not reset on in-step concat statuses", () => {
    assert.equal(shouldResetOverallProgressPercent("compatible-finalize"), false);
    assert.equal(shouldResetOverallProgressPercent("compatible-concat"), false);
    assert.equal(shouldResetOverallProgressPercent("fast-concat"), false);
    assert.equal(
      shouldResetOverallProgressPercent("Videoclips vorbereitet"),
      false,
    );
  });

  it("still resets on major create_job phase boundaries", () => {
    assert.equal(
      shouldResetOverallProgressPercent("Erstelle Wasserzeichen-Video…"),
      true,
    );
    assert.equal(shouldResetOverallProgressPercent("Kopiere Fotos…"), true);
  });
});
