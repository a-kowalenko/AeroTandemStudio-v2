import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
 *
 * Cache hits via `useSyncExternalStore` so virtualized tile remounts paint
 * synchronously without clearing to a spinner.
 */
export function usePhotoThumbnailSrc(
  path: string | null,
  quality: ThumbQuality,
  revision: number,
  priority: number,
  opts?: {
    enabled?: boolean;
    /** When false, failed/missing thumbs stay null (tiles). Default true for stage. */
    fallbackToFile?: boolean;
  },
): string | null {
  const enabled = opts?.enabled !== false;
  const fallbackToFile = opts?.fallbackToFile !== false;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!path) return () => {};
      return photoThumbnailQueue.subscribe(
        path,
        quality,
        revision,
        onStoreChange,
      );
    },
    [path, quality, revision],
  );

  const getSnapshot = useCallback(() => {
    if (!path) return null;
    return photoThumbnailQueue.getCached(path, quality, revision);
  }, [path, quality, revision]);

  const cachedUrl = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setFallbackUrl(null);
      return;
    }
    if (!enabled) {
      setFallbackUrl(null);
      return;
    }
    if (photoThumbnailQueue.getCached(path, quality, revision)) {
      setFallbackUrl(null);
      return;
    }

    let cancelled = false;
    setFallbackUrl(null);

    void photoThumbnailQueue
      .request(path, quality, priority, revision)
      .then((displayUrl) => {
        if (cancelled) return;
        // Cache notify updates `cachedUrl`; only need local fallback on empty.
        if (!displayUrl && fallbackToFile) {
          setFallbackUrl(photoFileSrcFallback(path, revision));
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (fallbackToFile) setFallbackUrl(photoFileSrcFallback(path, revision));
      });

    return () => {
      cancelled = true;
    };
  }, [path, quality, revision, priority, enabled, fallbackToFile]);

  if (cachedUrl) return cachedUrl;
  if (!enabled) return null;
  return fallbackUrl;
}
