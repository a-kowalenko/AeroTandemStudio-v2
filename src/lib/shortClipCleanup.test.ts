import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampCleanupShortVideosMaxSec,
  shouldRemoveShortVideo,
} from "./shortClipCleanupDecision.ts";

describe("shouldRemoveShortVideo", () => {
  const base = {
    enabled: true,
    maxSec: 5,
    durationSecs: 4,
    path: "C:/work/clip.mp4",
  };

  it("returns false when feature disabled", () => {
    assert.equal(shouldRemoveShortVideo({ ...base, enabled: false }), false);
  });

  it("returns false when duration exceeds max", () => {
    assert.equal(shouldRemoveShortVideo({ ...base, durationSecs: 6 }), false);
  });

  it("returns true at threshold", () => {
    assert.equal(shouldRemoveShortVideo({ ...base, durationSecs: 5 }), true);
  });

  it("returns false for unknown duration", () => {
    assert.equal(
      shouldRemoveShortVideo({ ...base, durationSecs: undefined }),
      false,
    );
    assert.equal(
      shouldRemoveShortVideo({ ...base, durationSecs: 0 }),
      false,
    );
    assert.equal(
      shouldRemoveShortVideo({ ...base, durationSecs: Number.NaN }),
      false,
    );
  });

  it("excludes paths case-insensitively", () => {
    assert.equal(
      shouldRemoveShortVideo({
        ...base,
        path: "C:\\work\\QR.MP4",
        excludePaths: ["c:/work/qr.mp4"],
      }),
      false,
    );
    assert.equal(
      shouldRemoveShortVideo({
        ...base,
        excludePaths: ["c:/other.mp4"],
      }),
      true,
    );
  });
});

describe("clampCleanupShortVideosMaxSec", () => {
  it("clamps to 1–60", () => {
    assert.equal(clampCleanupShortVideosMaxSec(0), 1);
    assert.equal(clampCleanupShortVideosMaxSec(5), 5);
    assert.equal(clampCleanupShortVideosMaxSec(100), 60);
  });
});
