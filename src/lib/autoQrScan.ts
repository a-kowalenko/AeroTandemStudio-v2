/** Auto QR scan after media import (videos and/or photos). */

import { useConfigStore } from "@/store/configStore";
import { useKundeStore } from "@/store/kundeStore";
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
  });
  return {
    message: formatted.message,
    kundeName: kundeDisplayName(result.kunde),
    successOptions: formatted.options,
    successTitle: formatted.title,
  };
}

/**
 * Scan newly imported media when the matching config flags are on.
 * Prefers video hits; falls back to photos if videos find nothing.
 */
export async function runAutoQrAfterImport(
  input: AutoQrScanInput,
): Promise<AutoQrScanOutcome> {
  const cfg = useConfigStore.getState().config;
  if (!cfg) return emptyOutcome();

  const videoPaths = input.videoPaths?.filter(Boolean) ?? [];
  const photoPaths = input.photoPaths?.filter(Boolean) ?? [];
  const scanVideos = cfg.qr_check_enabled && videoPaths.length > 0;
  const scanPhotos = cfg.photo_qr_check_enabled && photoPaths.length > 0;

  if (!scanVideos && !scanPhotos) return emptyOutcome();

  const applyFromQr = useKundeStore.getState().applyFromQr;

  if (scanVideos) {
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
      applyFromQr(result.kunde);
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
      applyFromQr(result.kunde);
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
