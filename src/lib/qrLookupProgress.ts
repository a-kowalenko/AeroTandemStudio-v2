/** AMS/Cloud lookup progress inside the QR scan panel (no second card / overlay). */

import { tr } from "@/i18n";
import type { QrIdChip } from "@/lib/qrSuccess";
import {
  useQrScanStore,
  type QrLookupIdChip,
  type QrLookupUiPhase,
} from "@/store/qrScanStore";
import { useUiStore } from "@/store/uiStore";

export type QrLookupResultKind =
  | "found"
  | "not_found"
  | "unreachable"
  | "error"
  | "offline";

export type QrLookupResult = {
  kind: QrLookupResultKind;
  /** Customer name when found; otherwise optional detail. */
  highlight?: string;
  /** Override summary (e.g. bridge error text). */
  message?: string;
};

export type QrLookupHooks = {
  /** Network lookup is about to start. */
  onLookupStart?: () => void;
  /** Final lookup outcome (never call with a fake "found"). */
  onLookupResult?: (result: QrLookupResult) => void;
};

export type QrLookupUiController = {
  hooks: QrLookupHooks;
  /** Clear lookup row; end panel if this flow pinned busy. */
  finish: () => void;
};

function phaseForResult(kind: QrLookupResultKind): QrLookupUiPhase {
  switch (kind) {
    case "found":
      return "found";
    case "not_found":
    case "offline":
      return "miss";
    case "unreachable":
    case "error":
      return "error";
  }
}

function summaryForResult(result: QrLookupResult): string {
  const custom = result.message?.trim();
  if (custom) return custom;
  switch (result.kind) {
    case "found":
      return tr("ams.lookup.foundTitle");
    case "not_found":
      return tr("ams.lookup.notFound");
    case "unreachable":
    case "offline":
      return tr("ams.status.unreachableLabel");
    case "error":
      return tr("ams.status.lookupErrorFallback");
  }
}

/**
 * Drive booking-lookup status on the existing QR progress panel.
 * Opens a lightweight busy job when the scan job already ended (manual hit path).
 */
export function createQrLookupUiController(opts: {
  highlight: string;
  /** Plain Kunden-/Booking-IDs as chips (kept across search → result). */
  idChips?: QrIdChip[];
}): QrLookupUiController {
  const highlight = opts.highlight.trim();
  const idChips: QrLookupIdChip[] = (opts.idChips ?? [])
    .map((c) => ({
      label: c.label.trim(),
      value: c.value.trim(),
    }))
    .filter((c) => c.label && c.value);
  let pinBusy = false;

  return {
    hooks: {
      onLookupStart: () => {
        if (useUiStore.getState().loading) {
          useUiStore.getState().setLoading(false);
        }
        const store = useQrScanStore.getState();
        store.ensureLookupBusy();
        pinBusy = true;
        store.setLookup({
          phase: "searching",
          highlight,
          summary: tr("ams.lookup.searching"),
          idChips: idChips.length ? idChips : undefined,
        });
      },
      onLookupResult: (result) => {
        const store = useQrScanStore.getState();
        if (!store.lookup) {
          store.ensureLookupBusy();
          pinBusy = true;
        }
        store.setLookup({
          phase: phaseForResult(result.kind),
          highlight: (result.highlight ?? highlight).trim(),
          summary: summaryForResult(result),
          idChips: idChips.length ? idChips : undefined,
        });
      },
    },
    finish: () => {
      const store = useQrScanStore.getState();
      store.setLookup(null);
      if (pinBusy) {
        store.end();
      }
      pinBusy = false;
    },
  };
}
