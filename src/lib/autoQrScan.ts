/** Auto QR scan after media import (videos and/or photos). */

import { useConfigStore } from "@/store/configStore";
import { useKundeStore } from "@/store/kundeStore";
import {
  useQrScanStore,
  type QrScanJobStage,
} from "@/store/qrScanStore";
import { useUiStore } from "@/store/uiStore";
import {
  scanQrPhotos,
  scanQrVideos,
} from "@/lib/tauri";
import {
  maybeRemoveQrPhoto,
  maybeRemoveQrVideo,
} from "@/lib/qrCleanup";
import { presentQrHit } from "@/lib/qrPresent";
import type { DialogOptions } from "@/store/uiStore";

export type AutoQrScanInput = {
  videoPaths?: string[];
  photoPaths?: string[];
  /**
   * When true, scan imported videos/photos regardless of
   * `qr_check_enabled` / `photo_qr_check_enabled`.
   */
  forceScan?: boolean;
  /** Called before a QR video clip is removed from the session list. */
  onBeforeRemoveVideo?: (path: string) => void;
};

export type AutoQrScanOutcome = {
  attempted: boolean;
  found: boolean;
  /** Kundedata written (false when user kept the existing QR customer). */
  applied: boolean;
  keptExisting: boolean;
  message: string;
  source_path: string | null;
  kundeName: string;
  /** Ready-to-use SuccessDialog options when found. */
  successOptions: DialogOptions | null;
  successTitle: string | null;
};

function emptyOutcome(): AutoQrScanOutcome {
  return {
    attempted: false,
    found: false,
    applied: false,
    keptExisting: false,
    message: "",
    source_path: null,
    kundeName: "",
    successOptions: null,
    successTitle: null,
  };
}

function setQrUi(message: string, stage: QrScanJobStage, paths?: string[]) {
  useUiStore.getState().setLoading(true, message);
  const store = useQrScanStore.getState();
  if (paths) {
    store.begin(paths, stage);
  } else {
    store.setStage(stage);
  }
}

/** Session already filled from a successful QR scan (`form_mode === "kunde"`). */
export function sessionHasQrKunde(): boolean {
  return useKundeStore.getState().kunde.form_mode === "kunde";
}

/**
 * Whether post-import auto QR should run.
 *
 * When the session is already in QR/kunde mode, skip unless `force` is true
 * (confirm-dialog checkbox). Matches SdFileSelector default and legacy photo skip.
 */
export function shouldAutoQrAfterImport(opts: {
  force?: boolean;
  videoPaths?: Iterable<string>;
  photoPaths?: Iterable<string>;
  qrCheckEnabled?: boolean | null;
  photoQrCheckEnabled?: boolean | null;
}): boolean {
  const videoPaths = [...(opts.videoPaths ?? [])].filter(Boolean);
  const photoPaths = [...(opts.photoPaths ?? [])].filter(Boolean);
  const force = Boolean(opts.force);
  if (!force && sessionHasQrKunde()) return false;
  if (force) return videoPaths.length > 0 || photoPaths.length > 0;
  return (
    (Boolean(opts.qrCheckEnabled) && videoPaths.length > 0) ||
    (Boolean(opts.photoQrCheckEnabled) && photoPaths.length > 0)
  );
}

/**
 * Scan newly imported media when the matching config flags are on,
 * or when `forceScan` is set (confirm-dialog override).
 * Skips when the session already has QR kundedata unless forced.
 * Prefers video hits; falls back to photos if videos find nothing.
 */
export async function runAutoQrAfterImport(
  input: AutoQrScanInput,
): Promise<AutoQrScanOutcome> {
  const cfg = useConfigStore.getState().config;
  if (!cfg) return emptyOutcome();

  const videoPaths = input.videoPaths?.filter(Boolean) ?? [];
  const photoPaths = input.photoPaths?.filter(Boolean) ?? [];
  const force = Boolean(input.forceScan);

  // Active QR session: keep existing kundedata; confirm can force via checkbox.
  if (!force && sessionHasQrKunde()) return emptyOutcome();

  const scanVideos =
    (force || cfg.qr_check_enabled) && videoPaths.length > 0;
  const scanPhotos =
    (force || cfg.photo_qr_check_enabled) && photoPaths.length > 0;

  if (!scanVideos && !scanPhotos) return emptyOutcome();

  // setQrUi turns on the global LoadingOverlay; always clear it here.
  // (Manual import has no SD-workflow finally — that used to leave the overlay stuck.)
  try {
    if (scanVideos) {
      setQrUi(
        `QR-Scan: ${videoPaths.length} Video(s)…`,
        "scanning_videos",
        videoPaths,
      );
      const result = await scanQrVideos(videoPaths);
      if (result.cancelled) {
        return {
          ...emptyOutcome(),
          attempted: true,
          message: result.message || "QR-Scan abgebrochen.",
        };
      }
      if (result.found && result.kunde) {
        useUiStore.getState().setLoading(false);
        const presented = await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path,
          preview: result.preview,
          showDialog: false,
          runCleanup: () => {
            setQrUi("QR gefunden — Clip prüfen…", "followup");
            return maybeRemoveQrVideo(result.source_path, {
              onBeforeRemove: input.onBeforeRemoveVideo,
            });
          },
        });
        return {
          attempted: true,
          found: true,
          applied: presented.applied,
          keptExisting: presented.keptExisting,
          source_path: result.source_path,
          message: presented.message,
          kundeName: presented.kundeName,
          successOptions: presented.successOptions,
          successTitle: presented.successTitle,
        };
      }
    }

    if (scanPhotos) {
      setQrUi(
        `QR-Scan: ${photoPaths.length} Foto(s)…`,
        "scanning_photos",
        photoPaths,
      );
      const result = await scanQrPhotos(photoPaths);
      if (result.cancelled) {
        return {
          ...emptyOutcome(),
          attempted: true,
          message: result.message || "QR-Scan abgebrochen.",
        };
      }
      if (result.found && result.kunde) {
        useUiStore.getState().setLoading(false);
        const presented = await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path,
          preview: result.preview,
          showDialog: false,
          runCleanup: async () => {
            setQrUi("QR gefunden — Nachbarfotos prüfen…", "followup");
            return maybeRemoveQrPhoto(result.source_path);
          },
        });
        return {
          attempted: true,
          found: true,
          applied: presented.applied,
          keptExisting: presented.keptExisting,
          source_path: result.source_path,
          message: presented.message,
          kundeName: presented.kundeName,
          successOptions: presented.successOptions,
          successTitle: presented.successTitle,
        };
      }
    }

    return {
      ...emptyOutcome(),
      attempted: true,
      message: "Kein QR-Code in den neuen Dateien gefunden.",
    };
  } finally {
    useUiStore.getState().setLoading(false);
  }
}

/** Paths that were added relative to a snapshot of existing paths. */
export function pathsAddedSince(
  beforePaths: Iterable<string>,
  afterPaths: Iterable<string>,
): string[] {
  const before = new Set(
    [...beforePaths].map((p) => p.replace(/\\/g, "/").toLowerCase()),
  );
  return [...afterPaths].filter(
    (p) => !before.has(p.replace(/\\/g, "/").toLowerCase()),
  );
}
