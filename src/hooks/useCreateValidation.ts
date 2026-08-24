import { tr } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfigStore } from "../store/configStore";
import { useKundeStore } from "../store/kundeStore";
import { usePhotoStore } from "../store/photoStore";
import { useVideoStore } from "../store/videoStore";
import { useUiStore } from "../store/uiStore";
import { useAmsBridgeStore } from "../store/amsBridgeStore";
import { validateCreateJob, normalizeManualEntryMode } from "../lib/tauri";
import { resolveCreateValidation } from "../lib/createReadyHints";
import { canRunAmsIdLookup, isAmsBridgeConfigured } from "../lib/amsLookup";

type Options = {
  ready: boolean;
  busy: boolean;
  pipelineActive: boolean;
  uiLocked: boolean;
};

export function useCreateValidation({
  ready,
  busy,
  pipelineActive,
  uiLocked,
}: Options) {
  const config = useConfigStore((s) => s.config);
  const kunde = useKundeStore((s) => s.kunde);
  const qrRevision = useKundeStore((s) => s.qrRevision);
  const amsLookupRevision = useKundeStore((s) => s.amsLookupRevision);
  const amsLookupSettled = useKundeStore((s) => s.amsLookupSettled);
  const sessionTouched = useKundeStore((s) => s.sessionTouched);
  const videoList = useVideoStore((s) => s.videoList);
  const photoList = usePhotoStore((s) => s.photoList);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);
  const createReadyPulsePending = useUiStore((s) => s.createReadyPulsePending);
  const clearCreateReadyPulse = useUiStore((s) => s.clearCreateReadyPulse);
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsCapabilities = useAmsBridgeStore((s) => s.capabilities);

  const [createHints, setCreateHints] = useState<string[]>([]);
  const [createReadyPulse, setCreateReadyPulse] = useState(false);
  const createReadyWasFalseRef = useRef(true);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const paths = videoList.map((v) => v.path);
        const photos = photoList.map((p) => p.path);
        const wmPhotos = [...watermarkPhotoIndices].sort((a, b) => a - b);
        try {
          const validation = await validateCreateJob(
            kunde,
            paths,
            photos,
            wmPhotos,
            config?.oldschool_mode,
          );
          if (cancelled) return;
          const hints = [...validation.errors];
          if (!config?.speicherort?.trim()) {
            hints.push(tr("create.validation.storageDeferredHint"));
          }
          setCreateHints(hints);
        } catch {
          if (!cancelled) {
            setCreateHints([tr("create.validation.failed")]);
          }
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    ready,
    kunde,
    videoList,
    photoList,
    watermarkPhotoIndices,
    config?.oldschool_mode,
    config?.manual_entry_mode,
    config?.speicherort,
    amsLookupSettled,
    amsConnected,
    amsCapabilities,
  ]);

  const hasMedia =
    (videoList.length > 0 || photoList.length > 0) && !pipelineActive;

  const workStarted =
    sessionTouched ||
    hasMedia ||
    qrRevision > 0 ||
    amsLookupRevision > 0;
  const manualEntryMode = normalizeManualEntryMode(
    config?.manual_entry_mode,
    config?.oldschool_mode ?? false,
  );
  const lookupLive = canRunAmsIdLookup({
    configured: isAmsBridgeConfigured(config),
    connected: amsConnected,
    capabilities: amsCapabilities,
  });

  const resolved = useMemo(
    () =>
      resolveCreateValidation(createHints, {
        formMode: kunde.form_mode,
        manualEntryMode,
        workStarted,
        pipelineActive,
        sessionTouched,
        hasMedia,
        qrApplied: qrRevision > 0,
        amsApplied: amsLookupRevision > 0,
        kundenId: kunde.kunden_id,
        bookingId: kunde.booking_id,
        amsLookupSettled,
        lookupLive,
      }),
    [
      createHints,
      kunde.form_mode,
      kunde.kunden_id,
      kunde.booking_id,
      manualEntryMode,
      workStarted,
      pipelineActive,
      sessionTouched,
      hasMedia,
      qrRevision,
      amsLookupRevision,
      amsLookupSettled,
      lookupLive,
    ],
  );

  const { createReady, createBanner: resolvedBanner } = resolved;
  const createBanner = busy ? null : resolvedBanner;

  useEffect(() => {
    const becameReady = createReadyWasFalseRef.current && createReady;
    createReadyWasFalseRef.current = !createReady;

    if (!createReadyPulsePending) return;
    if (!createReady) return;
    if (!becameReady) {
      clearCreateReadyPulse();
      return;
    }
    if (uiLocked) return;

    clearCreateReadyPulse();
    setCreateReadyPulse(true);
    const timer = window.setTimeout(() => setCreateReadyPulse(false), 2150);
    return () => window.clearTimeout(timer);
  }, [createReadyPulsePending, createReady, uiLocked, clearCreateReadyPulse]);

  useEffect(() => {
    if (!createReadyPulsePending || createReady) return;
    const timer = window.setTimeout(() => clearCreateReadyPulse(), 900);
    return () => window.clearTimeout(timer);
  }, [createReadyPulsePending, createReady, clearCreateReadyPulse]);

  return {
    createReady,
    createHints,
    createBanner,
    createReadyPulse,
    setCreateReadyPulse,
  };
}
