import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ThumbQuality } from "../../lib/sdCard";
import { photoThumbnailQueue } from "../../lib/photoThumbnailQueue";

export function photoFileSrcFallback(path: string, revision: number): string {
  const base = convertFileSrc(path);
  return `${base}${base.includes("?") ? "&" : "?"}r=${revision}`;
}

/**
 * Queued thumbnail (OPT-11): strip/grid/warm share limited concurrent jobs;
 * main stage uses file src + low-priority preview upgrade (LQ tiles win).
 */
export function usePhotoThumbnailSrc(
  path: string | null,
  quality: ThumbQuality,
  revision: number,
  priority: number,
  opts?: { enabled?: boolean },
): string | null {
  const enabled = opts?.enabled !== false;
  const [url, setUrl] = useState<string | null>(() =>
    path && enabled
      ? photoThumbnailQueue.getCached(path, quality, revision)
      : null,
  );

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    const cached = photoThumbnailQueue.getCached(path, quality, revision);
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

    void photoThumbnailQueue
      .request(path, quality, priority, revision)
      .then((displayUrl) => {
        if (!cancelled) setUrl(displayUrl || photoFileSrcFallback(path, revision));
      })
      .catch(() => {
        if (!cancelled) setUrl(photoFileSrcFallback(path, revision));
      });

    return () => {
      cancelled = true;
    };
  }, [path, quality, revision, priority, enabled]);

  return url;
}
