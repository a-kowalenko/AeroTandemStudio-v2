import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QR_LIVE_FRAME_CAP,
  QR_LIVE_TONE_SETTLE_MS,
  capQrLiveFrames,
  markLiveFramesRemoved,
  presentedQrLiveTone,
  retainLiveFramesForFollowup,
  videoPlaceholderFrames,
  type QrLivePresentFrame,
} from "./qrLivePresent.ts";

function frame(
  key: string,
  tone: QrLivePresentFrame["tone"],
  gen = 1,
): QrLivePresentFrame {
  return {
    key,
    mediaPath: key,
    livePath: `${key}.jpg`,
    gen,
    tone,
  };
}

describe("presentedQrLiveTone", () => {
  it("holds scan and hit until they settle", () => {
    assert.equal(presentedQrLiveTone(null, "scan", 0), null);
    assert.equal(presentedQrLiveTone(null, "scan", QR_LIVE_TONE_SETTLE_MS), "scan");
    assert.equal(presentedQrLiveTone("scan", "hit", 80), "scan");
    assert.equal(presentedQrLiveTone("scan", "hit", QR_LIVE_TONE_SETTLE_MS), "hit");
  });

  it("commits a miss or removal immediately and skips the pending tone", () => {
    assert.equal(presentedQrLiveTone(null, "miss", 0), "miss");
    assert.equal(presentedQrLiveTone("scan", "removed", 40), "removed");
    assert.equal(presentedQrLiveTone(null, "hit", 50), null);
  });

  it("paints the first video scan immediately and still holds a following hit", () => {
    assert.equal(
      presentedQrLiveTone(null, "scan", 0, QR_LIVE_TONE_SETTLE_MS, true),
      "scan",
    );
    assert.equal(
      presentedQrLiveTone("scan", "hit", 80, QR_LIVE_TONE_SETTLE_MS, true),
      "scan",
    );
    assert.equal(
      presentedQrLiveTone("scan", "hit", QR_LIVE_TONE_SETTLE_MS, QR_LIVE_TONE_SETTLE_MS, true),
      "hit",
    );
    assert.equal(
      presentedQrLiveTone(null, "hit", 0, QR_LIVE_TONE_SETTLE_MS, true),
      "hit",
    );
  });
});

describe("videoPlaceholderFrames", () => {
  it("adds a tile only for clips that have started and have no decode frame", () => {
    const frames = videoPlaceholderFrames(
      ["a.mp4", "b.mp4", "c.mp4"],
      { "a.mp4": "active", "b.mp4": "pending", "c.mp4": "hit" },
      new Set(["c.mp4"]),
      (key) => key,
    );
    assert.deepEqual(
      frames.map((f) => f.key),
      ["a.mp4"],
    );
    assert.equal(frames[0]?.tone, "scan");
    assert.equal(frames[0]?.livePath, "");
  });
});

describe("retainLiveFramesForFollowup", () => {
  it("keeps every thumb and does not reload the hit image", () => {
    const next = retainLiveFramesForFollowup(
      [frame("a", "miss", 3), frame("b", "scan", 4)],
      "b",
      "b",
    );
    assert.equal(next.length, 2);
    assert.equal(next[0]?.tone, "miss");
    assert.equal(next[0]?.gen, 3);
    assert.equal(next[1]?.tone, "hit");
    assert.equal(next[1]?.gen, 4);
    assert.equal(next[1]?.livePath, "b.jpg");
  });

  it("adds the hit only when the scan never published a frame", () => {
    const next = retainLiveFramesForFollowup([], "b", "B.jpg");
    assert.equal(next.length, 1);
    assert.equal(next[0]?.key, "b");
    assert.equal(next[0]?.tone, "hit");
    assert.equal(next[0]?.livePath, "B.jpg");
    assert.equal(next[0]?.gen, 1);
  });
});

describe("markLiveFramesRemoved", () => {
  it("changes tone in place and leaves other thumbs", () => {
    const next = markLiveFramesRemoved(
      [frame("a", "hit", 2), frame("b", "scan", 5)],
      new Set(["a"]),
    );
    assert.equal(next.length, 2);
    assert.equal(next[0]?.tone, "removed");
    assert.equal(next[0]?.gen, 2);
    assert.equal(next[0]?.livePath, "a.jpg");
    assert.equal(next[1]?.tone, "scan");
    assert.equal(next[1]?.gen, 5);
  });
});

describe("capQrLiveFrames", () => {
  it("drops the oldest scan frames and keeps the hit", () => {
    const frames = [
      frame("hit", "hit"),
      ...Array.from({ length: QR_LIVE_FRAME_CAP }, (_, i) => frame(`s${i}`, "scan")),
    ];
    const next = capQrLiveFrames(frames);
    assert.equal(next.length, QR_LIVE_FRAME_CAP);
    assert.equal(next[0]?.key, "hit");
    assert.equal(
      next.some((f) => f.key === "s0"),
      false,
    );
    assert.equal(next[next.length - 1]?.key, `s${QR_LIVE_FRAME_CAP - 1}`);
  });
});
