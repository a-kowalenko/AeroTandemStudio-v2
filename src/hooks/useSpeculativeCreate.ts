import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "../store/configStore";
import { useKundeStore } from "../store/kundeStore";
import { usePhotoStore } from "../store/photoStore";
import { useVideoStore } from "../store/videoStore";
import { normalizeBodyConcatMode } from "../lib/bodyConcatMode";
import { speculativeMediaReadyFromKunde } from "../lib/speculativeMediaReady";
import {
  cancelSpeculativeCreate,
  speculativeCreateStatus,
  startSpeculativeCreate,
  type SpeculativePhase,
  type SpeculativeStatus,
} from "../lib/tauri";

/** Debounce after core media/encode fingerprint is stable. */
const DEBOUNCE_MS = 400;
/** Extra settle after pipeline becomes idle (import/QR/SD). */
const SETTLE_MS = 1000;

type Options = {
  /** Create / append / encode session busy (after Erstellen click). */
  busy: boolean;
  pipelineActive: boolean;
  sdWorkflowUiActive: boolean;
  /** True when a matching preview can be reused — skip speculative work. */
  canReusePreview?: boolean;
};

function buildMediaRevisionTag(
  videoPaths: string[],
  photoPaths: string[],
  videoRev: Record<string, number>,
  photoRev: Record<string, number>,
): string {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const lines: string[] = [];
  for (const p of videoPaths) {
    lines.push(`v:${p}:${videoRev[norm(p)] ?? 0}`);
  }
  for (const p of photoPaths) {
    lines.push(`p:${p}:${photoRev[norm(p)] ?? 0}`);
  }
  return lines.join("\n");
}

export { buildMediaRevisionTag };

function kundeRecognizedViaQrOrLookup(
  qrRevision: number,
  amsLookupRevision: number,
  amsLookupSettled: boolean,
): boolean {
  if (qrRevision > 0) return true;
  return amsLookupRevision > 0 && amsLookupSettled;
}

/**
 * Phase 46 — speculative create when session is settled
 * (pipeline idle + media/products + QR/lookup), without waiting for full createReady.
 */
export function useSpeculativeCreate({
  busy,
  pipelineActive,
  sdWorkflowUiActive,
  canReusePreview = false,
}: Options) {
  const config = useConfigStore((s) => s.config);
  const kunde = useKundeStore((s) => s.kunde);
  const qrRevision = useKundeStore((s) => s.qrRevision);
  const amsLookupRevision = useKundeStore((s) => s.amsLookupRevision);
  const amsLookupSettled = useKundeStore((s) => s.amsLookupSettled);
  const videoList = useVideoStore((s) => s.videoList);
  const mediaRevision = useVideoStore((s) => s.mediaRevision);
  const photoList = usePhotoStore((s) => s.photoList);
  const photoMediaRevision = usePhotoStore((s) => s.mediaRevision);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);

  const [status, setStatus] = useState<SpeculativeStatus | null>(null);
  const [sessionSettled, setSessionSettled] = useState(false);
  const requestGen = useRef(0);
  const lastCoreKey = useRef<string>("");
  const lastReconcileKey = useRef<string>("");

  const videoPaths = videoList.map((v) => v.path);
  const photoPaths = photoList.map((p) => p.path);
  const mediaTag = buildMediaRevisionTag(
    videoPaths,
    photoPaths,
    mediaRevision,
    photoMediaRevision,
  );

  const introEnabled = Boolean(config?.intro_enabled ?? false);
  const bodyMode = normalizeBodyConcatMode(config?.body_concat_mode);
  const speculativeEnabled = config?.speculative_create_enabled !== false;
  const recognized = kundeRecognizedViaQrOrLookup(
    qrRevision,
    amsLookupRevision,
    amsLookupSettled,
  );
  const wmPhotosSorted = [...watermarkPhotoIndices].sort((a, b) => a - b);
  const mediaProductsOk = speculativeMediaReadyFromKunde(
    kunde,
    videoPaths.length,
    photoPaths.length,
  );

  /** Raw idle — pipeline quiet; settle timer arms on this. */
  const pipelineIdle =
    !pipelineActive && !sdWorkflowUiActive && !canReusePreview && !busy;

  useEffect(() => {
    if (!pipelineIdle) {
      setSessionSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSessionSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pipelineIdle]);

  /** Body/photos/encode — excludes WM *photo* selection (marks must not restart staging). */
  const coreKey = [
    videoPaths.join("|"),
    photoPaths.join("|"),
    mediaTag,
    kunde.handcam_video,
    kunde.outside_video,
    kunde.handcam_foto,
    kunde.outside_foto,
    kunde.ist_bezahlt_handcam_video,
    kunde.ist_bezahlt_outside_video,
    watermarkClipIndex ?? "",
    bodyMode,
    introEnabled,
    config?.video_codec ?? "auto",
    config?.preview_encode_crf ?? 18,
    config?.parallel_processing_enabled ?? true,
    config?.hardware_acceleration_enabled ?? false,
    recognized,
    mediaProductsOk,
    speculativeEnabled,
  ].join("::");

  /**
   * WM photo selection is intentionally NOT part of the start key.
   * Toggling WM marks must not invoke staging (CPU freeze). Unpaid WM video
   * is staged with the body; photo WMs are created at commit.
   */
  const canStart =
    speculativeEnabled &&
    !introEnabled &&
    bodyMode === "compatible" &&
    recognized &&
    mediaProductsOk &&
    sessionSettled &&
    !canReusePreview;

  const invokeStart = async (gen: number) => {
    if (gen !== requestGen.current) return;
    try {
      const codec = (config?.video_codec ?? "auto") as "auto" | "h264" | "h265";
      const next = await startSpeculativeCreate(kunde, videoPaths, photoPaths, {
        watermark_clip_index: watermarkClipIndex,
        watermark_photo_indices: wmPhotosSorted,
        media_revision_tag: mediaTag,
        video: {
          dauer: config?.dauer ?? 5,
          intro_enabled: false,
          video_codec: codec === "h265" || codec === "h264" ? codec : "auto",
          crf: config?.preview_encode_crf ?? 18,
          parallel_enabled: config?.parallel_processing_enabled ?? true,
          intro_mux_mode: config?.intro_mux_mode ?? "reencode",
          body_concat_mode: "compatible",
          hw_accel_enabled: config?.hardware_acceleration_enabled ?? false,
        },
      });
      if (gen !== requestGen.current) return;
      setStatus(next);
    } catch {
      if (gen === requestGen.current) setStatus(null);
    }
  };

  useEffect(() => {
    // While create_job runs, backend owns the slot (attach/commit).
    if (busy) return;

    if (!canStart) {
      // Keep staging while pipeline is busy (import/QR/SD) — canceling would
      // race cancel_encode into the import. Only drop on hard precondition fails.
      const hardFail =
        !speculativeEnabled ||
        introEnabled ||
        bodyMode !== "compatible" ||
        !recognized ||
        !mediaProductsOk ||
        canReusePreview;
      if (hardFail && lastCoreKey.current) {
        lastCoreKey.current = "";
        lastReconcileKey.current = "";
        requestGen.current += 1;
        void cancelSpeculativeCreate().catch(() => {});
        setStatus(null);
      }
      return;
    }

    if (coreKey === lastCoreKey.current) return;

    lastCoreKey.current = coreKey;
    const gen = ++requestGen.current;

    const timer = window.setTimeout(() => {
      void invokeStart(gen);
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- coreKey aggregates deps
  }, [
    coreKey,
    busy,
    sessionSettled,
    pipelineIdle,
    canReusePreview,
    speculativeEnabled,
    introEnabled,
    bodyMode,
    recognized,
    mediaProductsOk,
    canStart,
  ]);

  // After Ready: one reconcile for deferred photo pending (core only — never WM toggles).
  useEffect(() => {
    if (busy || !canStart) return;
    if (!status || status.phase !== "ready") return;
    const reconcileKey = `${status.staging_id ?? ""}::${coreKey}`;
    if (reconcileKey === lastReconcileKey.current) return;
    lastReconcileKey.current = reconcileKey;
    const gen = ++requestGen.current;
    const timer = window.setTimeout(() => {
      void invokeStart(gen);
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.phase, status?.staging_id, coreKey, busy, canStart]);

  // Poll while running for chip updates.
  useEffect(() => {
    if (busy) return;
    if (!status || status.phase !== "running") return;
    const id = window.setInterval(() => {
      void speculativeCreateStatus()
        .then((s) => setStatus(s))
        .catch(() => {});
    }, 500);
    return () => window.clearInterval(id);
  }, [status?.phase, busy]);

  // Cleanup on unmount only (not on busy).
  useEffect(() => {
    return () => {
      requestGen.current += 1;
      void cancelSpeculativeCreate().catch(() => {});
    };
  }, []);

  const phase: SpeculativePhase | "idle" = status?.phase ?? "idle";
  // Keep chip during import settle — staging must survive pipelineActive.
  const chipVisible =
    !busy &&
    speculativeEnabled &&
    !introEnabled &&
    bodyMode === "compatible" &&
    recognized &&
    mediaProductsOk &&
    !canReusePreview &&
    (phase === "running" || phase === "ready");

  return {
    phase,
    chipVisible,
    status,
    mediaRevisionTag: mediaTag,
    getMediaRevisionTag: () => mediaTag,
  };
}
