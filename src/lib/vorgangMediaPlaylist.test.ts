import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultViewableIndex,
  findViewableIndex,
  isDateiViewable,
  isPreviewOrWmRole,
  isSourceOrMarkerRole,
  isViewableRole,
  partitionDeliveryAndPreview,
} from "./vorgangMediaPlaylist.ts";
import type { ViewableMediaItem, VorgangFileEntry } from "./vorgangHistory.ts";

function item(
  partial: Partial<ViewableMediaItem> & Pick<ViewableMediaItem, "path" | "role">,
): ViewableMediaItem {
  return {
    id: partial.id ?? null,
    vorgang_id: 1,
    filename: partial.filename ?? "f",
    media_type: partial.media_type ?? "video",
    role: partial.role,
    size_bytes: null,
    path: partial.path,
    append_id: null,
    append_folder_name: null,
  };
}

describe("vorgangMediaPlaylist", () => {
  it("classifies delivery vs source roles", () => {
    assert.equal(isViewableRole("output_video"), true);
    assert.equal(isViewableRole("handcam_foto"), true);
    assert.equal(isViewableRole("source_video"), false);
    assert.equal(isSourceOrMarkerRole("source_photo"), true);
    assert.equal(isSourceOrMarkerRole("marker"), true);
  });

  it("separates preview / watermark roles", () => {
    assert.equal(isPreviewOrWmRole("wm_video"), true);
    assert.equal(isPreviewOrWmRole("preview_foto"), true);
    assert.equal(isPreviewOrWmRole("append_preview_video"), true);
    assert.equal(isPreviewOrWmRole("output_video"), false);
    assert.equal(isPreviewOrWmRole("handcam_foto"), false);
  });

  it("partitions delivery and preview lists", () => {
    const { delivery, preview } = partitionDeliveryAndPreview([
      item({ path: "a.mp4", role: "output_video" }),
      item({ path: "b.mp4", role: "wm_video" }),
      item({ path: "c.jpg", role: "preview_foto", media_type: "photo" }),
      item({ path: "d.jpg", role: "handcam_foto", media_type: "photo" }),
    ]);
    assert.deepEqual(
      delivery.map((x) => x.path),
      ["a.mp4", "d.jpg"],
    );
    assert.deepEqual(
      preview.map((x) => x.path),
      ["b.mp4", "c.jpg"],
    );
  });

  it("defaults to first delivery video then any video", () => {
    assert.equal(defaultViewableIndex([]), -1);
    assert.equal(
      defaultViewableIndex([
        item({ path: "wm.mp4", role: "wm_video" }),
        item({ path: "final.mp4", role: "output_video" }),
      ]),
      1,
    );
    assert.equal(
      defaultViewableIndex([
        item({ path: "a.jpg", role: "handcam_foto", media_type: "photo" }),
        item({ path: "b.mp4", role: "output_video", media_type: "video" }),
      ]),
      1,
    );
  });

  it("matches dateien rows by id or path", () => {
    const playlist = [
      item({ id: 10, path: "C:\\out\\a.mp4", role: "output_video" }),
      item({
        id: null,
        path: "C:\\out\\b.jpg",
        role: "handcam_foto",
        media_type: "photo",
      }),
    ];
    const byId: VorgangFileEntry = {
      id: 10,
      vorgang_id: 1,
      filename: "a.mp4",
      media_type: "video",
      role: "output_video",
      size_bytes: null,
      path: "other",
      append_id: null,
      append_folder_name: null,
    };
    assert.equal(findViewableIndex(playlist, byId), 0);
    assert.equal(
      findViewableIndex(playlist, {
        id: 99,
        path: "c:/out/b.jpg",
      }),
      1,
    );
    assert.equal(isDateiViewable(playlist, byId), true);
  });
});
