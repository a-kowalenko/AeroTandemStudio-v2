import { useEffect, useState } from "react";
import type { ThumbQuality } from "../lib/sdCard";
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
  opts?: {
    enabled?: boolean;
    quality?: ThumbQuality;
    /** Serialized behind the active poster so tile warms do not run beside playback. */
    background?: boolean;
  },
): string | null {
  const enabled = opts?.enabled !== false;
  const quality = opts?.quality ?? "preview";
  const background = opts?.background === true;
  const [url, setUrl] = useState<string | null>(() =>
    path && enabled ? previewThumbnailQueue.getCached(path, bustKey, quality) : null,
  );

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    const cached = previewThumbnailQueue.getCached(path, bustKey, quality);
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
      .request(path, priority, bustKey, quality, { background })
      .then((displayUrl) => {
        if (!cancelled) setUrl(displayUrl);
      })
      .catch(() => {
        if (cancelled) return;
        // Player/strip may have filled the cache even if this waiter errored.
        setUrl(previewThumbnailQueue.getCached(path, bustKey, quality));
      });

    return () => {
      cancelled = true;
    };
  }, [path, bustKey, priority, enabled, quality, background]);

  return url;
}

export function videoPosterBustKey(
  sizeBytes: number,
  durationSecs: number,
  revision: number,
): string {
  return `${sizeBytes}-${durationSecs}-${revision}`;
}
