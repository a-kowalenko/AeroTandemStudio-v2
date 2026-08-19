import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/configStore";
import { useKundeStore } from "../store/kundeStore";
import { usePhotoStore } from "../store/photoStore";
import { useVideoStore } from "../store/videoStore";
import { useUiStore } from "../store/uiStore";
import { useAmsBridgeStore } from "../store/amsBridgeStore";
import { previewEncodingSignature, getPreviewReusePlan } from "../store/previewCacheStore";
import { formatPreviewReuseHint } from "../lib/previewReuseHint";
import { validateCreateJob, normalizeManualEntryMode } from "../lib/tauri";
import {
  filterGraceCreateHints,
  isBlockingCreateHint,
  isIdEntryGracePeriod,
  summarizeCreateHints,
} from "../lib/createReadyHints";
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
  const { t } = useTranslation();
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

  const [createReady, setCreateReady] = useState(false);
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
            hints.push("Speicherort wird beim Erstellen abgefragt und gespeichert.");
          }
          setCreateHints(hints);
          const manualMode = normalizeManualEntryMode(
            config?.manual_entry_mode,
            config?.oldschool_mode ?? false,
          );
          const grace = isIdEntryGracePeriod({
            active: kunde.form_mode === "manual" && manualMode === "id",
            kundenId: kunde.kunden_id,
            bookingId: kunde.booking_id,
            amsLookupSettled,
            lookupLive: canRunAmsIdLookup({
              configured: isAmsBridgeConfigured(config),
              connected: amsConnected,
              capabilities: amsCapabilities,
            }),
          });
          const blocking = filterGraceCreateHints(
            hints.filter(isBlockingCreateHint),
            grace,
          );
          setCreateReady(blocking.length === 0);
        } catch {
          if (!cancelled) {
            setCreateReady(false);
            setCreateHints(["Validierung fehlgeschlagen"]);
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

  const workStarted =
    sessionTouched ||
    videoList.length > 0 ||
    photoList.length > 0 ||
    qrRevision > 0 ||
    amsLookupRevision > 0;
  const manualEntryMode = normalizeManualEntryMode(
    config?.manual_entry_mode,
    config?.oldschool_mode ?? false,
  );
  const idEntryGrace = isIdEntryGracePeriod({
    active: kunde.form_mode === "manual" && manualEntryMode === "id",
    kundenId: kunde.kunden_id,
    bookingId: kunde.booking_id,
    amsLookupSettled,
    lookupLive: canRunAmsIdLookup({
      configured: isAmsBridgeConfigured(config),
      connected: amsConnected,
      capabilities: amsCapabilities,
    }),
  });
  const createBanner = busy
    ? null
    : summarizeCreateHints(createHints, {
        workStarted,
        suppressEmptyMedia: pipelineActive,
        idEntryGrace,
      });

  const createNeedsVideoEncode =
    videoList.length > 0 && (kunde.handcam_video || kunde.outside_video);
  const createEncodeHint = useMemo(() => {
    if (!createNeedsVideoEncode) return null;
    const encodingSig = previewEncodingSignature(
      Boolean(config?.intro_enabled ?? false),
      config?.dauer ?? 5,
      config?.intro_mux_mode ?? "reencode",
    );
    return formatPreviewReuseHint(
      t,
      getPreviewReusePlan(videoList, kunde, encodingSig),
    );
  }, [
    createNeedsVideoEncode,
    videoList,
    kunde,
    config?.intro_enabled,
    config?.dauer,
    config?.intro_mux_mode,
    t,
  ]);

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
    createEncodeHint,
    createReadyPulse,
    setCreateReadyPulse,
  };
}
