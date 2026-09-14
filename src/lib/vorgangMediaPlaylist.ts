import type { ViewableMediaItem, VorgangFileEntry } from "@/lib/vorgangHistory";

/** Roles that belong in the Vorgang media viewer playlist. */
export const VIEWABLE_ROLES = new Set([
  "output_video",
  "wm_video",
  "handcam_video",
  "outside_video",
  "handcam_foto",
  "outside_foto",
  "preview_video",
  "preview_foto",
  "append_handcam_video",
  "append_outside_video",
  "append_handcam_foto",
  "append_outside_foto",
  "append_preview_video",
  "append_preview_foto",
]);

/** Preview / watermark deliverables (not the paid final product). */
const PREVIEW_OR_WM_ROLES = new Set([
  "wm_video",
  "preview_video",
  "preview_foto",
  "append_preview_video",
  "append_preview_foto",
]);

export function isViewableRole(role: string): boolean {
  return VIEWABLE_ROLES.has(role);
}

export function isPreviewOrWmRole(role: string): boolean {
  return PREVIEW_OR_WM_ROLES.has(role);
}

export function isSourceOrMarkerRole(role: string): boolean {
  return (
    role === "source_video" ||
    role === "source_photo" ||
    role === "marker"
  );
}

function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

/** Index of a dateien row inside the viewable playlist, or -1. */
export function findViewableIndex(
  playlist: ViewableMediaItem[],
  file: Pick<VorgangFileEntry, "id" | "path">,
): number {
  if (file.id != null) {
    const byId = playlist.findIndex((item) => item.id === file.id);
    if (byId >= 0) return byId;
  }
  const path = file.path?.trim();
  if (!path) return -1;
  const key = pathKey(path);
  return playlist.findIndex((item) => pathKey(item.path) === key);
}

export function isDateiViewable(
  playlist: ViewableMediaItem[],
  file: VorgangFileEntry,
): boolean {
  return findViewableIndex(playlist, file) >= 0;
}

/** Prefer first delivery video, then any video, then first item. */
export function defaultViewableIndex(playlist: ViewableMediaItem[]): number {
  if (playlist.length === 0) return -1;
  const deliveryVideo = playlist.findIndex(
    (item) => item.media_type === "video" && !isPreviewOrWmRole(item.role),
  );
  if (deliveryVideo >= 0) return deliveryVideo;
  const video = playlist.findIndex((item) => item.media_type === "video");
  return video >= 0 ? video : 0;
}

export function partitionDeliveryAndPreview<T extends { role: string }>(
  items: T[],
): { delivery: T[]; preview: T[] } {
  const delivery: T[] = [];
  const preview: T[] = [];
  for (const item of items) {
    if (isPreviewOrWmRole(item.role)) preview.push(item);
    else delivery.push(item);
  }
  return { delivery, preview };
}
