import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignVideoLiveThumbs, placeQrLiveFrames } from "./qrLiveLayout.ts";

function keys(entries: { item: { key: string } }[]): string[] {
  return entries.map((entry) => entry.item.key);
}

describe("placeQrLiveFrames", () => {
  const order = ["a.mp4", "b.mp4", "c.mp4", "d.mp4"];

  it("keeps the list start on the left and the list end on the right", () => {
    const layout = placeQrLiveFrames(
      [
        { key: "d.mp4" },
        { key: "a.mp4" },
      ],
      order,
    );
    assert.deepEqual(keys(layout.start), ["a.mp4"]);
    assert.equal(layout.hit, null);
    assert.deepEqual(keys(layout.end), ["d.mp4"]);
  });

  it("orders each side by list index, not by update order", () => {
    const layout = placeQrLiveFrames(
      [
        { key: "b.mp4" },
        { key: "d.mp4" },
        { key: "c.mp4" },
        { key: "a.mp4" },
      ],
      order,
    );
    assert.deepEqual(keys(layout.start), ["a.mp4", "b.mp4"]);
    assert.deepEqual(keys(layout.end), ["c.mp4", "d.mp4"]);
  });

  it("puts a two-file list on opposite sides", () => {
    const layout = placeQrLiveFrames(
      [{ key: "last.mp4" }, { key: "first.mp4" }],
      ["first.mp4", "last.mp4"],
    );
    assert.deepEqual(keys(layout.start), ["first.mp4"]);
    assert.deepEqual(keys(layout.end), ["last.mp4"]);
  });

  it("pins long-list edge clips to the outer docks", () => {
    const long = Array.from({ length: 20 }, (_, i) => `v${i}.mp4`);
    const layout = placeQrLiveFrames(
      [
        { key: "v19.mp4" },
        { key: "v0.mp4" },
        { key: "v1.mp4" },
        { key: "v18.mp4" },
      ],
      long,
    );
    assert.deepEqual(keys(layout.start), ["v0.mp4", "v1.mp4"]);
    assert.deepEqual(keys(layout.end), ["v18.mp4", "v19.mp4"]);
    assert.equal(layout.start[0]?.index, 0);
    assert.equal(layout.end[1]?.index, 19);
  });

  it("centers the follow-up hit and keeps neighbors on their side", () => {
    const photos = Array.from({ length: 12 }, (_, i) => `p${i}.jpg`);
    const layout = placeQrLiveFrames(
      [
        { key: "p11.jpg" },
        { key: "p9.jpg" },
        { key: "p10.jpg" },
        { key: "p8.jpg" },
      ],
      photos,
      "p10.jpg",
    );
    assert.deepEqual(keys(layout.start), ["p8.jpg", "p9.jpg"]);
    assert.equal(layout.hit?.item.key, "p10.jpg");
    assert.equal(layout.hit?.index, 10);
    assert.deepEqual(keys(layout.end), ["p11.jpg"]);
  });

  it("does not let a later hit steal the follow-up anchor", () => {
    const photos = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
    const layout = placeQrLiveFrames(
      [
        { key: "a.jpg" },
        { key: "b.jpg" },
        { key: "c.jpg" },
      ],
      photos,
      "b.jpg",
    );
    assert.deepEqual(keys(layout.start), ["a.jpg"]);
    assert.equal(layout.hit?.item.key, "b.jpg");
    assert.deepEqual(keys(layout.end), ["c.jpg"]);
  });

  it("keeps unknown paths on the left", () => {
    const layout = placeQrLiveFrames(
      [{ key: "missing.mp4" }, { key: "d.mp4" }],
      order,
    );
    assert.deepEqual(keys(layout.start), ["missing.mp4"]);
    assert.deepEqual(keys(layout.end), ["d.mp4"]);
  });
});

describe("alignVideoLiveThumbs", () => {
  it("aligns a video batch of at most four clips", () => {
    assert.equal(alignVideoLiveThumbs("scanning_videos", 4), true);
    assert.equal(alignVideoLiveThumbs("scanning_videos", 1), true);
    assert.equal(alignVideoLiveThumbs("scanning_videos", 5), false);
    assert.equal(alignVideoLiveThumbs("scanning_photos", 4), false);
    assert.equal(alignVideoLiveThumbs("followup", 4), false);
  });
});
