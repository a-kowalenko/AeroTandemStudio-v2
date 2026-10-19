/** OPT-29: post-import session cleanup for ultra-short video stubs (backup unchanged). */

import type { AutoQrScanOutcome } from "@/lib/autoQrScan";
import { tr } from "@/i18n";
import { useConfigStore } from "@/store/configStore";
import { useVideoStore } from "@/store/videoStore";
import {
  deleteWorkingCopies,
  deleteWorkingCopy,
  type DeleteWorkingCopyPathResult,
} from "@/lib/tauri";
import {
  QR_LIVE_REMOVED_EXIT_MS,
  SHORT_CLIP_BULK_REMOVED_MS,
} from "@/lib/qrLivePresent";
import { previewThumbnailQueue } from "@/lib/thumbnailQueue";
import { useQrScanStore } from "@/store/qrScanStore";
import { useUiStore } from "@/store/uiStore";
import {
  clampCleanupShortVideosMaxSec,
  defaultCleanupShortVideosMaxSec,
  shouldRemoveShortVideo,
  shortClipPathKey,
  type ShouldRemoveShortVideoInput,
} from "@/lib/shortClipCleanupDecision";

export type { ShouldRemoveShortVideoInput };
export {
  clampCleanupShortVideosMaxSec,
  defaultCleanupShortVideosMaxSec,
  shouldRemoveShortVideo,
} from "@/lib/shortClipCleanupDecision";

export type ShortClipCleanupResult = {
  removedPaths: string[];
};

export function emptyShortClipCleanup(): ShortClipCleanupResult {
  return { removedPaths: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

type VideoListEntry = ReturnType<typeof useVideoStore.getState>["videoList"][number];

function applyDeleteResults(
  results: DeleteWorkingCopyPathResult[],
  result: ShortClipCleanupResult,
  videosByPath: Map<string, VideoListEntry>,
) {
  for (const item of results) {
    if (item.status !== "deleted") {
      const video = videosByPath.get(shortClipPathKey(item.path));
      if (video && item.status === "failed") {
        console.warn(
          `Kurzclip bleibt in Liste (Arbeitskopie nicht gelöscht): ${video.filename}`,
          item.reason ?? item.status,
        );
      }
      continue;
    }
    useVideoStore.getState().removeVideoFromList(item.path);
    result.removedPaths.push(item.path);
  }
}

async function retryFailedDeletes(
  failedPaths: string[],
  videosByPath: Map<string, VideoListEntry>,
  result: ShortClipCleanupResult,
  qrBusy: boolean,
) {
  const qr = useQrScanStore.getState();
  for (const path of failedPaths) {
    const video = videosByPath.get(shortClipPathKey(path));
    if (!video) continue;
    if (qrBusy) {
      qr.setShortClipHygieneProgress(result.removedPaths.length, path);
    }
    previewThumbnailQueue.preparePathsForDeletion([path]);
    let del = await deleteWorkingCopyAfterThumbIdle(path);
    if (del.status !== "deleted") {
      for (let attempt = 0; attempt < 2 && del.status !== "deleted"; attempt++) {
        await sleep(250 * (attempt + 1));
        previewThumbnailQueue.preparePathsForDeletion([path]);
        del = await deleteWorkingCopyAfterThumbIdle(path);
      }
    }
    if (del.status === "deleted") {
      useVideoStore.getState().removeVideoFromList(path);
      result.removedPaths.push(path);
    } else {
      console.warn(
        `Kurzclip bleibt in Liste (Arbeitskopie nicht gelöscht): ${video.filename}`,
        del.reason ?? del.status,
      );
    }
    if (qrBusy) {
      qr.setShortClipHygieneProgress(result.removedPaths.length, path);
    }
  }
}

async function deleteWorkingCopyAfterThumbIdle(path: string) {
  await previewThumbnailQueue.awaitReadyForDelete(path, 4000);
  return deleteWorkingCopy(path);
}

/**
 * Remove newly imported clips from the session when ≤ configured max duration.
 * Does not touch backup folders. Unknown duration → keep.
 */
export async function maybeRemoveShortVideosAfterImport(
  paths: string[],
  options?: {
    excludePaths?: string[];
    onBeforeRemove?: (path: string) => void;
  },
): Promise<ShortClipCleanupResult> {
  const result: ShortClipCleanupResult = { removedPaths: [] };
  if (paths.length === 0) return result;

  const cfg = useConfigStore.getState().config;
  if (!cfg?.cleanup_short_videos_after_import) return result;

  const maxSec = clampCleanupShortVideosMaxSec(cfg.cleanup_short_videos_max_sec);
  const exclude = options?.excludePaths ?? [];
  const videoList = useVideoStore.getState().videoList;
  const pathKey = shortClipPathKey;
  const pending: VideoListEntry[] = [];

  for (const path of paths) {
    const video = videoList.find((v) => pathKey(v.path) === pathKey(path));
    if (!video) continue;

    const remove = shouldRemoveShortVideo({
      enabled: true,
      maxSec,
      durationSecs: video.duration_secs,
      path: video.path,
      excludePaths: exclude,
    });
    if (!remove) {
      const excluded = exclude.some((ex) => pathKey(ex) === pathKey(video.path));
      if (excluded) continue;
      const duration = video.duration_secs;
      if (!Number.isFinite(duration) || duration <= 0) {
        console.warn(
          `Kurzclip nicht entfernt (Dauer unbekannt): ${video.filename}`,
        );
      } else if (duration > maxSec) {
        console.info(
          `Kurzclip nicht entfernt (${duration.toFixed(1)}s > ${maxSec}s): ${video.filename}`,
        );
      }
      continue;
    }

    pending.push(video);
  }

  if (pending.length === 0) return result;

  const pendingPaths = pending.map((v) => v.path);
  const videosByPath = new Map(
    pending.map((v) => [pathKey(v.path), v] as const),
  );
  const qrStore = useQrScanStore.getState();
  const qrBusy = qrStore.busy;

  for (const video of pending) {
    options?.onBeforeRemove?.(video.path);
  }

  previewThumbnailQueue.preparePathsForDeletion(pendingPaths);
  await previewThumbnailQueue.awaitReadyForDeleteAll(pendingPaths, 4000);

  if (qrBusy) {
    qrStore.beginShortClipHygiene(pendingPaths.length);
    qrStore.markRemoved(pendingPaths);
    const holdMs =
      pendingPaths.length > 1
        ? SHORT_CLIP_BULK_REMOVED_MS
        : QR_LIVE_REMOVED_EXIT_MS;
    await sleep(holdMs);
    qrStore.setShortClipHygieneProgress(0, pendingPaths[0] ?? null);
  }

  const batchResults = await deleteWorkingCopies(pendingPaths);
  applyDeleteResults(batchResults, result, videosByPath);

  if (qrBusy) {
    qrStore.setShortClipHygieneProgress(result.removedPaths.length, null);
  }

  const failedPaths = batchResults
    .filter((r) => r.status !== "deleted")
    .map((r) => r.path);
  if (failedPaths.length > 0) {
    await retryFailedDeletes(failedPaths, videosByPath, result, qrBusy);
  }

  if (qrBusy) {
    qrStore.setShortClipHygieneProgress(pendingPaths.length, null);
    qrStore.endShortClipHygiene();
  }

  return result;
}

export type PostImportVideoHygieneInput = {
  newVideoPaths: string[];
  qrOutcome?: AutoQrScanOutcome | null;
  onBeforeRemoveVideo?: (path: string) => void;
};

/** Single post-import sweep after QR (or when QR was skipped). */
export async function runPostImportVideoHygiene(
  input: PostImportVideoHygieneInput,
): Promise<ShortClipCleanupResult> {
  const ui = useUiStore.getState();
  ui.beginPostImportHygiene();
  try {
    const exclude: string[] = [];
    if (input.qrOutcome?.found && input.qrOutcome.source_path) {
      exclude.push(input.qrOutcome.source_path);
    }
    return await maybeRemoveShortVideosAfterImport(input.newVideoPaths, {
      excludePaths: exclude,
      onBeforeRemove: input.onBeforeRemoveVideo,
    });
  } finally {
    useUiStore.getState().endPostImportHygiene();
  }
}

/** Append to import completion summary when clips were removed. */
export function formatShortClipCleanupSummary(
  cleanup: ShortClipCleanupResult,
): string {
  const n = cleanup.removedPaths.length;
  if (n === 0) return "";

  const cfg = useConfigStore.getState().config;
  const maxSec = clampCleanupShortVideosMaxSec(
    cfg?.cleanup_short_videos_max_sec ?? defaultCleanupShortVideosMaxSec(),
  );
  const part = tr(
    n === 1
      ? "app.import.shortClipRemoved"
      : "app.import.shortClipRemovedMany",
    { count: n, maxSec },
  );
  return ` · ${part}`;
}
