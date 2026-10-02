import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSpeculativeMediaReady } from "./speculativeMediaReady.ts";

const none = {
  handcam_video: false,
  outside_video: false,
  handcam_foto: false,
  outside_foto: false,
};

describe("isSpeculativeMediaReady", () => {
  it("is false without products", () => {
    assert.equal(isSpeculativeMediaReady({ ...none, videoCount: 3, photoCount: 3 }), false);
  });

  it("video product needs videos", () => {
    const k = { ...none, handcam_video: true };
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 0, photoCount: 5 }), false);
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 1, photoCount: 0 }), true);
  });

  it("foto-only product needs photos", () => {
    const k = { ...none, outside_foto: true };
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 2, photoCount: 0 }), false);
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 0, photoCount: 1 }), true);
  });

  it("video + foto starts with videos before photos are imported", () => {
    const k = { ...none, handcam_video: true, handcam_foto: true };
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 2, photoCount: 0 }), true);
    assert.equal(isSpeculativeMediaReady({ ...k, videoCount: 0, photoCount: 4 }), false);
  });
});
