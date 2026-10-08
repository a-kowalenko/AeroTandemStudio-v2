/** AMS/Cloud lookup progress inside the QR scan panel (no second card / overlay). */

import { tr } from "@/i18n";
import { useQrScanStore } from "@/store/qrScanStore";
import { useUiStore } from "@/store/uiStore";

export type QrLookupHooks = {
  /** Network lookup is about to start. */
  onLookupStart?: () => void;
  /** Network settled; UI may still show type-choice / confirms. */
  onLookupSettled?: () => void;
};

export type QrLookupUiController = {
  hooks: QrLookupHooks;
  /** Clear lookup row; end panel if this flow opened it alone. */
  finish: () => void;
};

/**
 * Drive booking-lookup status on the existing QR progress panel.
 * Opens a lightweight busy job when the scan job already ended (manual hit path).
 */
export function createQrLookupUiController(opts: {
  highlight: string;
}): QrLookupUiController {
  const highlight = opts.highlight.trim();
  /** True if this controller (or follow-up) left us responsible for ending busy. */
  let pinBusy = false;

  return {
    hooks: {
      onLookupStart: () => {
        if (useUiStore.getState().loading) {
          useUiStore.getState().setLoading(false);
        }
        const store = useQrScanStore.getState();
        // Always pin: even when the scan job is already busy, cleanup may
        // endFollowup while lookup still runs — we must keep the panel open.
        store.ensureLookupBusy();
        pinBusy = true;
        store.setLookup({
          phase: "searching",
          highlight,
          summary: tr("ams.lookup.searching"),
        });
      },
      onLookupSettled: () => {
        const store = useQrScanStore.getState();
        const prev = store.lookup;
        store.setLookup({
          phase: "found",
          highlight: prev?.highlight?.trim() || highlight,
          summary: tr("ams.lookup.searching"),
        });
      },
    },
    finish: () => {
      const store = useQrScanStore.getState();
      store.setLookup(null);
      if (pinBusy) {
        // Safe even if withQrScanProgress will end() again in its finally.
        store.end();
      }
      pinBusy = false;
    },
  };
}

/** Update highlight/summary after AMS returned a customer name (panel stays). */
export function updateQrLookupFound(opts: {
  highlight: string;
  summary?: string;
}): void {
  const store = useQrScanStore.getState();
  if (!store.lookup) return;
  store.setLookup({
    phase: "found",
    highlight: opts.highlight.trim() || store.lookup.highlight,
    summary: opts.summary?.trim() || tr("ams.lookup.foundTitle"),
  });
}
