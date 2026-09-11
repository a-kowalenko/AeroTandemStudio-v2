import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSpeculativeMediaReady } from "../src/lib/speculativeMediaReady.ts";

const base = {
  handcam_video: false,
  outside_video: false,
  handcam_foto: false,
  outside_foto: false,
  videoCount: 0,
  photoCount: 0,
};

describe("isSpeculativeMediaReady", () => {
  it("rejects empty products", () => {
    assert.equal(isSpeculativeMediaReady(base), false);
  });

  it("requires videos for video product", () => {
    assert.equal(
      isSpeculativeMediaReady({ ...base, handcam_video: true, videoCount: 0 }),
      false,
    );
    assert.equal(
      isSpeculativeMediaReady({ ...base, handcam_video: true, videoCount: 1 }),
      true,
    );
  });

  it("requires photos for photo product", () => {
    assert.equal(
      isSpeculativeMediaReady({ ...base, handcam_foto: true, photoCount: 0 }),
      false,
    );
    assert.equal(
      isSpeculativeMediaReady({ ...base, handcam_foto: true, photoCount: 2 }),
      true,
    );
  });

  it("allows unpaid photos without watermark selection (WM is create-time / optional staging)", () => {
    assert.equal(
      isSpeculativeMediaReady({
        ...base,
        handcam_foto: true,
        photoCount: 2,
        watermarkPhotoCount: 0,
        ist_bezahlt_handcam_foto: false,
      }),
      true,
    );
  });

  it("allows video+foto when both media present", () => {
    assert.equal(
      isSpeculativeMediaReady({
        ...base,
        handcam_video: true,
        outside_foto: true,
        videoCount: 1,
        photoCount: 3,
      }),
      true,
    );
  });
});
