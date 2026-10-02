import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { EncodeProgress } from "../components/app/types";
import { useProgressStore } from "../store/progressStore";

/**
 * Feed `encode-progress` into `progressStore` (mount once in `App`).
 * `isSessionCancelRequested` drops events after the user cancelled the session job.
 */
export function useEncodeProgressListener(isSessionCancelRequested: () => boolean): void {
  const cancelledRef = useRef(isSessionCancelRequested);
  cancelledRef.current = isSessionCancelRequested;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<EncodeProgress>("encode-progress", (event) => {
      if (cancelledRef.current()) return;
      useProgressStore.getState().applyEncodeProgress(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
