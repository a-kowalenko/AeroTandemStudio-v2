import { useCallback, useSyncExternalStore } from "react";
import type { SdThumbnailLoader, ThumbState } from "../lib/sdThumbnailLoader";

/** Subscribe a single path to the shared SD thumbnail loader (no parent re-render). */
export function useSdThumb(
  loader: SdThumbnailLoader,
  path: string,
): ThumbState | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => loader.subscribe(path, onStoreChange),
    [loader, path],
  );
  const getSnapshot = useCallback(() => loader.getBest(path), [loader, path]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
