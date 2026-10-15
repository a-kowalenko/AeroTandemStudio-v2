/** AMS/Cloud lookup progress inside the QR scan panel (no second card / overlay). */

import { tr } from "@/i18n";
import type { QrIdChip } from "@/lib/qrSuccess";
import {
  pickQrLookupThumb,
  type QrLookupThumbPick,
  type QrLookupThumbPickPreview,
} from "@/lib/qrLookupThumb";
import {
  useQrScanStore,
  type QrLookupIdChip,
  type QrLookupThumb,
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
  /**
   * Show the lookup row before async AMS work (cleanup may mark the carrier
   * removed while network lookup is still starting).
   */
  primeLookupRow: () => void;
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

function toStoreThumb(pick: QrLookupThumbPick | null): QrLookupThumb | null {
  if (!pick) return null;
  return {
    path: pick.path,
    gen: pick.gen,
    spotlight: pick.spotlight,
    mediaPath: pick.mediaPath,
    aspectRatio: pick.aspectRatio,
  };
}

function resolvePinnedThumb(
  pinned: QrLookupThumb | null,
  sourcePath?: string | null,
  preview?: QrLookupThumbPickPreview | null,
): QrLookupThumb | null {
  if (pinned) return pinned;
  return toStoreThumb(
    pickQrLookupThumb({
      frames: useQrScanStore.getState().liveFrames,
      sourcePath,
      preview,
    }),
  );
}

/**
 * Drive booking-lookup status on the existing QR progress panel.
 * Opens a lightweight busy job when the scan job already ended (manual hit path).
 */
export function createQrLookupUiController(opts: {
  highlight: string;
  /** Plain Kunden-/Booking-IDs as chips (kept across search → result). */
  idChips?: QrIdChip[];
  sourcePath?: string | null;
  /** Stable QR hit frame; preferred over live decode thumbs. */
  preview?: QrLookupThumbPickPreview | null;
}): QrLookupUiController {
  const highlight = opts.highlight.trim();
  const idChips: QrLookupIdChip[] = (opts.idChips ?? [])
    .map((c) => ({
      label: c.label.trim(),
      value: c.value.trim(),
    }))
    .filter((c) => c.label && c.value);
  // Pin before carrier leave / ensureLookupBusy clears live frames.
  let thumb = toStoreThumb(
    pickQrLookupThumb({
      frames: useQrScanStore.getState().liveFrames,
      sourcePath: opts.sourcePath,
      preview: opts.preview,
    }),
  );
  let pinBusy = false;

  const showSearching = () => {
    if (useUiStore.getState().loading) {
      useUiStore.getState().setLoading(false);
    }
    const store = useQrScanStore.getState();
    thumb = resolvePinnedThumb(thumb, opts.sourcePath, opts.preview);
    store.ensureLookupBusy();
    pinBusy = true;
    if (store.lookup?.phase === "searching") {
      if (thumb && !store.lookup.thumb?.path.trim()) {
        store.setLookup({ ...store.lookup, thumb });
      }
      return;
    }
    store.setLookup({
      phase: "searching",
      highlight,
      summary: tr("ams.lookup.searching"),
      idChips: idChips.length ? idChips : undefined,
      thumb,
    });
  };

  return {
    primeLookupRow: showSearching,
    hooks: {
      onLookupStart: showSearching,
      onLookupResult: (result) => {
        const store = useQrScanStore.getState();
        if (!store.lookup) {
          thumb = resolvePinnedThumb(thumb, opts.sourcePath, opts.preview);
          store.ensureLookupBusy();
          pinBusy = true;
        } else if (!thumb && store.lookup.thumb) {
          thumb = store.lookup.thumb;
        }
        store.setLookup({
          phase: phaseForResult(result.kind),
          highlight: (result.highlight ?? highlight).trim(),
          summary: summaryForResult(result),
          idChips: idChips.length ? idChips : undefined,
          thumb,
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
