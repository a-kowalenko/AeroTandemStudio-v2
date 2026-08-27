import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUploadQueueStore } from "@/store/uploadQueueStore";
import { abortAllUploadsForExit } from "@/lib/uploadSlot";
import { cancelEncode, cancelSecondaryBackup, cancelUploadSlot } from "@/lib/tauri";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Intercept window close while background upload slot/queue has work.
 * Shows a confirm dialog; on quit cancels uploads and destroys the window.
 */
export function useUploadQuitGuard(opts: {
  openConfirm: () => void;
  confirmOpen: boolean;
}): {
  onConfirmQuit: () => Promise<void>;
  onConfirmStay: () => void;
} {
  const pendingCloseRef = useRef(false);
  const confirmOpenRef = useRef(opts.confirmOpen);
  confirmOpenRef.current = opts.confirmOpen;
  const openConfirmRef = useRef(opts.openConfirm);
  openConfirmRef.current = opts.openConfirm;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (pendingCloseRef.current) return;
          const hasWork = useUploadQueueStore.getState().hasWork();
          if (!hasWork) return;
          event.preventDefault();
          if (confirmOpenRef.current) return;
          openConfirmRef.current();
        });
      } catch {
        /* browser / missing permissions */
      }
      if (cancelled) unlisten?.();
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function onConfirmQuit() {
    pendingCloseRef.current = true;
    abortAllUploadsForExit();
    try {
      await Promise.all([
        cancelEncode(),
        cancelUploadSlot(),
        cancelSecondaryBackup(),
      ]);
    } catch {
      /* best-effort cancel before destroy */
    }
    if (!isTauriRuntime()) return;
    try {
      await getCurrentWindow().destroy();
    } catch {
      try {
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
    }
  }

  function onConfirmStay() {
    pendingCloseRef.current = false;
  }

  return { onConfirmQuit, onConfirmStay };
}

/** Local open-state helper paired with `useUploadQuitGuard`. */
export function useQuitUploadConfirmState() {
  const [open, setOpen] = useState(false);
  return {
    open,
    openConfirm: () => setOpen(true),
    closeConfirm: () => setOpen(false),
    setOpen,
  };
}
