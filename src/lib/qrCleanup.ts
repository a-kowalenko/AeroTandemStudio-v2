/** Post-QR cleanup: remove carrier media from the session lists when configured. */

import { useConfigStore } from "@/store/configStore";
import { usePhotoStore } from "@/store/photoStore";
import { useVideoStore } from "@/store/videoStore";
import { useQrScanStore } from "@/store/qrScanStore";
import { scanQrPhotoFollowups } from "@/lib/tauri";

export type QrCleanupResult = {
  removedVideos: string[];
  removedPhotos: string[];
};

export function emptyCleanup(): QrCleanupResult {
  return { removedVideos: [], removedPhotos: [] };
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function removePhotosByPaths(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const keys = new Set(paths.map(pathKey));
  const list = usePhotoStore.getState().photoList;
  const indices: number[] = [];
  const removed: string[] = [];
  list.forEach((p, i) => {
    if (keys.has(pathKey(p.path))) {
      indices.push(i);
      removed.push(p.path);
    }
  });
  if (indices.length > 0) {
    usePhotoStore.getState().removePhotos(indices);
  }
  return removed;
}

/**
 * After a successful video QR scan: remove the source clip from the list if
 * `qr_remove_video_after_scan` is on and duration ≤ max (default 10s).
 */
export function maybeRemoveQrVideo(
  sourcePath: string | null | undefined,
  options?: { onBeforeRemove?: (path: string) => void },
): QrCleanupResult {
  const result: QrCleanupResult = { removedVideos: [], removedPhotos: [] };
  if (!sourcePath) return result;

  const cfg = useConfigStore.getState().config;
  if (!cfg?.qr_remove_video_after_scan) return result;

  const video = useVideoStore
    .getState()
    .videoList.find((v) => pathKey(v.path) === pathKey(sourcePath));
  if (!video) return result;

  const maxSec = cfg.qr_remove_video_max_duration_sec > 0
    ? cfg.qr_remove_video_max_duration_sec
    : 10;
  const duration = video.duration_secs;
  if (!Number.isFinite(duration) || duration <= 0) {
    console.warn(
      `QR-Video nicht entfernt (Dauer unbekannt): ${video.filename}`,
    );
    return result;
  }
  if (duration > maxSec) {
    console.info(
      `QR-Video nicht entfernt (${duration.toFixed(1)}s > ${maxSec}s): ${video.filename}`,
    );
    return result;
  }

  options?.onBeforeRemove?.(video.path);
  useVideoStore.getState().removeVideo(video.path);
  result.removedVideos.push(video.path);
  return result;
}

/**
 * After a successful photo QR scan:
 * 1. Remove the QR photo if `qr_remove_photo_after_scan` is on.
 * 2. Bidirectionally scan same-series neighbors (gap ≤ 10s); remove QR carriers.
 *    Stops per direction after 3 consecutive non-QR photos (scan cap 40).
 * Progress stripes stay visible during follow-up; carriers turn red before drop.
 */
export async function maybeRemoveQrPhoto(
  sourcePath: string | null | undefined,
): Promise<QrCleanupResult> {
  const result: QrCleanupResult = { removedVideos: [], removedPhotos: [] };
  if (!sourcePath) return result;

  const cfg = useConfigStore.getState().config;
  if (!cfg?.qr_remove_photo_after_scan) return result;

  const list = usePhotoStore.getState().photoList;
  const idx = list.findIndex((p) => pathKey(p.path) === pathKey(sourcePath));
  if (idx < 0) return result;

  const hitPath = list[idx].path;
  const orderedPaths = list.map((p) => p.path);
  const store = useQrScanStore.getState();
  store.beginFollowup(orderedPaths, hitPath);

  const toRemove = new Set<string>([hitPath]);

  try {
    try {
      const followHits = await scanQrPhotoFollowups(orderedPaths, hitPath);
      for (const path of followHits) {
        toRemove.add(path);
      }
    } catch (e) {
      console.warn(`QR-Follow-up Scan fehlgeschlagen:`, e);
    }

    const removeList = [...toRemove];
    store.markRemoved(removeList);
    // Brief pause so red stripes are readable before list rows disappear.
    await sleep(900);
    result.removedPhotos = removePhotosByPaths(removeList);
  } finally {
    store.end();
  }

  return result;
}

/** Human-readable summary for success dialogs. */
export function formatQrCleanupSummary(cleanup: QrCleanupResult): string {
  const parts: string[] = [];
  if (cleanup.removedVideos.length > 0) {
    const n = cleanup.removedVideos.length;
    parts.push(`${n} Clip${n === 1 ? "" : "s"} aus Liste entfernt`);
  }
  if (cleanup.removedPhotos.length > 0) {
    const n = cleanup.removedPhotos.length;
    parts.push(`${n} Foto${n === 1 ? "" : "s"} aus Liste entfernt`);
  }
  return parts.length > 0 ? `\n${parts.join(", ")}.` : "";
}
