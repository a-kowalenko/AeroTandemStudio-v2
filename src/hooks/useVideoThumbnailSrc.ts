import { useEffect, useState } from "react";
import {
  previewThumbnailQueue,
  type ThumbPriority,
  THUMB_PRIORITY,
} from "../lib/thumbnailQueue";

/**
 * Queued FFmpeg poster (OPT-10). Same cache keys as VideoPlayer / clip boost.
 */
export function useVideoThumbnailSrc(
  path: string | null,
  bustKey: string | number | null | undefined,
  priority: ThumbPriority | number = THUMB_PRIORITY.onDemand,
  opts?: { enabled?: boolean },
): string | null {
  const enabled = opts?.enabled !== false;
  const [url, setUrl] = useState<string | null>(() =>
    path && enabled ? previewThumbnailQueue.getCached(path, bustKey) : null,
  );

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    const cached = previewThumbnailQueue.getCached(path, bustKey);
    if (!enabled) {
      if (cached) setUrl(cached);
      return;
    }
    let cancelled = false;
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);

    void previewThumbnailQueue
      .request(path, priority, bustKey)
      .then((displayUrl) => {
        if (!cancelled) setUrl(displayUrl);
      })
      .catch(() => {
        if (cancelled) return;
        // Player/strip may have filled the cache even if this waiter errored.
        setUrl(previewThumbnailQueue.getCached(path, bustKey));
      });

    return () => {
      cancelled = true;
    };
  }, [path, bustKey, priority, enabled]);

  return url;
}

export function videoPosterBustKey(
  sizeBytes: number,
  durationSecs: number,
  revision: number,
): string {
  return `${sizeBytes}-${durationSecs}-${revision}`;
}
