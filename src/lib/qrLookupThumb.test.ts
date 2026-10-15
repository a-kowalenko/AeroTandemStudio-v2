import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickQrLookupThumb } from "./qrLookupThumb.ts";

describe("pickQrLookupThumb", () => {
  it("prefers QrPreview over live frames", () => {
    const pick = pickQrLookupThumb({
      frames: [
        {
          key: "a",
          mediaPath: "/a.mp4",
          livePath: "/live/a.jpg",
          gen: 3,
          tone: "hit",
        },
      ],
      sourcePath: "/a.mp4",
      preview: {
        path: "/preview/qr.jpg",
        width: 1920,
        height: 1080,
        spotlight: { x: 0.1, y: 0.2, size: 0.3 },
      },
    });
    assert.deepEqual(pick, {
      path: "/preview/qr.jpg",
      gen: 0,
      spotlight: { x: 0.1, y: 0.2, size: 0.3 },
      mediaPath: "/a.mp4",
      aspectRatio: 1920 / 1080,
    });
  });

  it("picks the source hit frame when no preview", () => {
    const pick = pickQrLookupThumb({
      frames: [
        {
          key: "/b.mp4",
          mediaPath: "/b.mp4",
          livePath: "/live/b.jpg",
          gen: 2,
          tone: "hit",
        },
        {
          key: "/a.mp4",
          mediaPath: "/a.mp4",
          livePath: "/live/a.jpg",
          gen: 4,
          tone: "removed",
        },
      ],
      sourcePath: "/A.mp4",
    });
    assert.deepEqual(pick, {
      path: "/live/a.jpg",
      gen: 4,
      spotlight: null,
      mediaPath: "/a.mp4",
      aspectRatio: 16 / 9,
    });
  });

  it("falls back to any hit then removed", () => {
    const hit = pickQrLookupThumb({
      frames: [
        {
          key: "x",
          mediaPath: "/x.jpg",
          livePath: "/live/x.jpg",
          gen: 1,
          tone: "removed",
        },
        {
          key: "y",
          mediaPath: "/y.jpg",
          livePath: "/live/y.jpg",
          gen: 2,
          tone: "hit",
        },
      ],
    });
    assert.equal(hit?.path, "/live/y.jpg");

    const removedOnly = pickQrLookupThumb({
      frames: [
        {
          key: "x",
          mediaPath: "/x.jpg",
          livePath: "/live/x.jpg",
          gen: 1,
          tone: "removed",
        },
      ],
    });
    assert.equal(removedOnly?.path, "/live/x.jpg");
  });

  it("returns null without preview or carrier frame", () => {
    assert.equal(
      pickQrLookupThumb({
        frames: [
          {
            key: "a",
            mediaPath: "/a.mp4",
            livePath: "/live/a.jpg",
            gen: 1,
            tone: "scan",
          },
        ],
      }),
      null,
    );
  });
});
