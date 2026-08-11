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
  type QrScanResult,
} from "@/lib/tauri";
import {
  maybeRemoveQrPhoto,
  maybeRemoveQrVideo,
  type QrCleanupResult,
} from "@/lib/qrCleanup";
import {
  formatQrSuccess,
  kundeDisplayName,
} from "@/lib/qrSuccess";
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

function formatHit(
  result: QrScanResult,
  cleanup: QrCleanupResult,
): Pick<
  AutoQrScanOutcome,
  "message" | "kundeName" | "successOptions" | "successTitle"
> {
  const formatted = formatQrSuccess({
    kunde: result.kunde,
    cleanup,
    sourcePath: result.source_path,
    preview: result.preview,
  });
  return {
    message: formatted.message,
    kundeName: kundeDisplayName(result.kunde),
    successOptions: formatted.options,
    successTitle: formatted.title,
  };
}

/**
 * Scan newly imported media when the matching config flags are on,
 * or when `forceScan` is set (confirm-dialog override).
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
  const scanVideos =
    (force || cfg.qr_check_enabled) && videoPaths.length > 0;
  const scanPhotos =
    (force || cfg.photo_qr_check_enabled) && photoPaths.length > 0;

  if (!scanVideos && !scanPhotos) return emptyOutcome();

  const applyFromQr = useKundeStore.getState().applyFromQr;

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
          attempted: true,
          found: false,
          message: result.message || "QR-Scan abgebrochen.",
          source_path: null,
          kundeName: "",
          successOptions: null,
          successTitle: null,
        };
      }
      if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path,
        });
        setQrUi("QR gefunden — Clip prüfen…", "followup");
        const cleanup = maybeRemoveQrVideo(result.source_path, {
          onBeforeRemove: input.onBeforeRemoveVideo,
        });
        return {
          attempted: true,
          found: true,
          source_path: result.source_path,
          ...formatHit(result, cleanup),
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
          attempted: true,
          found: false,
          message: result.message || "QR-Scan abgebrochen.",
          source_path: null,
          kundeName: "",
          successOptions: null,
          successTitle: null,
        };
      }
      if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path,
        });
        setQrUi("QR gefunden — Nachbarfotos prüfen…", "followup");
        const cleanup = await maybeRemoveQrPhoto(result.source_path);
        return {
          attempted: true,
          found: true,
          source_path: result.source_path,
          ...formatHit(result, cleanup),
        };
      }
    }

    return {
      attempted: true,
      found: false,
      message: "Kein QR-Code in den neuen Dateien gefunden.",
      source_path: null,
      kundeName: "",
      successOptions: null,
      successTitle: null,
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
