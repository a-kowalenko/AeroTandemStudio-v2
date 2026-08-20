import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Film,
  FolderOpen,
  ImageIcon,
  Images,
  QrCode,
  ScanSearch,
  Trash2,
  Upload,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useVideoStore } from "../store/videoStore";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useConfigStore } from "../store/configStore";
import { useUiStore } from "../store/uiStore";
import { useSdStore } from "../store/sdStore";
import { useAppendStore } from "../store/appendStore";
import { photoEdgeScanPaths, withQrScanProgress } from "../store/qrScanStore";
import {
  isImportCancellation,
  rollbackImportBatch,
} from "../lib/importRollback";
import {
  clearWorkingSession,
  expandMediaPaths,
  scanQrPhoto,
  scanQrPhotos,
  scanQrVideo,
  scanQrVideos,
} from "../lib/tauri";
import { emptyCleanup, maybeRemoveQrPhoto, maybeRemoveQrVideo } from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import {
  pathsAddedSince,
  runAutoQrAfterImport,
  shouldAutoQrAfterImport,
} from "../lib/autoQrScan";
import {
  requestKundenIdFocus,
  requestKundenIdFocusAfterImport,
} from "../lib/kundenIdFocus";
import {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  mediaKind,
  splitMediaPaths,
} from "../lib/media";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { cn } from "@/lib/utils";
import { CREATE_READY_IDS } from "@/lib/createReadyHints";

export type MediaImportSummary = {
  videosAdded: number;
  photosAdded: number;
};

export function MediaDropZone({
  onRemoveVideo,
  onSessionCleared,
  onImported,
  disabled = false,
}: {
  onRemoveVideo?: (path: string) => void;
  /** Fired when the user clears all media (working session wiped). */
  onSessionCleared?: () => void;
  /** Fired after a successful import (for media-tab switching). */
  onImported?: (summary: MediaImportSummary) => void;
  /** External lock (e.g. SD auto workflow) — disables import / scan actions. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const videoList = useVideoStore((s) => s.videoList);
  const importing = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const importError = useVideoStore((s) => s.importError);
  const addVideos = useVideoStore((s) => s.addVideos);
  const clearVideos = useVideoStore((s) => s.clearVideos);
  const clearError = useVideoStore((s) => s.clearError);

  const photoList = usePhotoStore((s) => s.photoList);
  const addPhotos = usePhotoStore((s) => s.addPhotos);
  const clearPhotos = usePhotoStore((s) => s.clearPhotos);

  const kunde = useKundeStore((s) => s.kunde);
  const ensureDefaultWatermarkClip = useVideoStore((s) => s.ensureDefaultWatermarkClip);
  const clearVideoWatermark = useVideoStore((s) => s.clearWatermarkSelection);
  const clearPhotoWatermark = usePhotoStore((s) => s.clearWatermarkSelection);
  const config = useConfigStore((s) => s.config);
  const persistConfig = useConfigStore((s) => s.persist);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);

  const dropLockedRef = useRef(false);
  const appendCapturesDrop = useAppendStore((s) => s.captureFileDrop);

  const [dragOver, setDragOver] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [scanActionsLayout, setScanActionsLayout] = useState<
    "full" | "compact" | "wrap"
  >("full");
  const qrBarRef = useRef<HTMLDivElement>(null);
  const qrLeadRef = useRef<HTMLDivElement>(null);
  const qrFullMeasureRef = useRef<HTMLDivElement>(null);
  const qrCompactMeasureRef = useRef<HTMLDivElement>(null);
  const prevMediaCountRef = useRef(videoList.length + photoList.length);
  const dropZoneId = useId();

  // Clear import/QR status when media is wiped externally (e.g. session reset).
  useEffect(() => {
    const count = videoList.length + photoList.length;
    if (prevMediaCountRef.current > 0 && count === 0) {
      setStatusMsg(null);
    }
    prevMediaCountRef.current = count;
  }, [videoList.length, photoList.length]);

  const autoQrVideos = Boolean(config?.qr_check_enabled);
  const autoQrPhotos = Boolean(config?.photo_qr_check_enabled);

  // full → compact labels → wrap button row (only if compact still doesn't fit)
  useLayoutEffect(() => {
    const bar = qrBarRef.current;
    const lead = qrLeadRef.current;
    const fullMeasure = qrFullMeasureRef.current;
    const compactMeasure = qrCompactMeasureRef.current;
    if (!bar || !lead || !fullMeasure || !compactMeasure) return;

    const GAP_X = 16; // matches gap-x-4

    const update = () => {
      const style = getComputedStyle(bar);
      const padX =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      const available = bar.clientWidth - padX;
      const leadW = lead.offsetWidth;
      const fullNeeded = leadW + GAP_X + fullMeasure.offsetWidth;
      const compactNeeded = leadW + GAP_X + compactMeasure.offsetWidth;
      if (fullNeeded <= available) setScanActionsLayout("full");
      else if (compactNeeded <= available) setScanActionsLayout("compact");
      else setScanActionsLayout("wrap");
    };

    const ro = new ResizeObserver(update);
    ro.observe(bar);
    ro.observe(lead);
    ro.observe(fullMeasure);
    ro.observe(compactMeasure);
    update();
    return () => ro.disconnect();
  }, [videoList.length, photoList.length]);

  const compactScanLabels = scanActionsLayout !== "full";
  const wrapScanActions = scanActionsLayout === "wrap";

  const videoWmNeeded =
    (kunde.handcam_video && !kunde.ist_bezahlt_handcam_video) ||
    (kunde.outside_video && !kunde.ist_bezahlt_outside_video);
  const fotoWmNeeded =
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto) ||
    (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto);

  useEffect(() => {
    if (videoWmNeeded) ensureDefaultWatermarkClip();
    else clearVideoWatermark();
  }, [videoWmNeeded, ensureDefaultWatermarkClip, clearVideoWatermark, videoList.length]);

  useEffect(() => {
    if (!fotoWmNeeded) clearPhotoWatermark();
  }, [fotoWmNeeded, clearPhotoWatermark]);

  async function setAutoQrFlag(
    key: "qr_check_enabled" | "photo_qr_check_enabled",
    value: boolean,
  ) {
    if (!config) return;
    const next = { ...config, [key]: value };
    const saved = await persistConfig(next);
    if (!saved) {
      showError(t("media.drop.saveFailed"));
    }
  }

  const clearManualImportProgress = useCallback(() => {
    const { workflowActive, workflowProgress, setWorkflowProgress } =
      useSdStore.getState();
    if (!workflowActive && workflowProgress?.stage === "import") {
      setWorkflowProgress(null);
    }
  }, []);

  const handlePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      clearError();
      setStatusMsg(null);
      clearManualImportProgress();
      setExpanding(true);

      try {
        const expanded = await expandMediaPaths(paths);
        const { videos, photos, skipped } = splitMediaPaths(expanded);
        const beforeVideoPaths = useVideoStore.getState().videoList.map((v) => v.path);
        const beforePhotoPaths = usePhotoStore.getState().photoList.map((p) => p.path);

        try {
          if (videos.length > 0) {
            await addVideos(videos);
          }
          if (photos.length > 0) {
            await addPhotos(photos);
          }
        } catch (importErr) {
          if (isImportCancellation(importErr)) {
            await rollbackImportBatch({ beforeVideoPaths, beforePhotoPaths });
          }
          throw importErr;
        }

        const afterVideos = useVideoStore.getState().videoList;
        const afterPhotos = usePhotoStore.getState().photoList;
        const newVideoPaths = pathsAddedSince(
          beforeVideoPaths,
          afterVideos.map((v) => v.path),
        );
        const newPhotoPaths = pathsAddedSince(
          beforePhotoPaths,
          afterPhotos.map((p) => p.path),
        );
        const videosAdded = newVideoPaths.length;
        const photosAdded = newPhotoPaths.length;

        if (videosAdded === 0 && photosAdded === 0) {
          if (expanded.length === 0 || (skipped.length > 0 && videos.length === 0 && photos.length === 0)) {
            setStatusMsg(t("media.drop.noneFound"));
          } else {
            setStatusMsg(t("media.drop.alreadyInList"));
          }
          return;
        }

        const parts: string[] = [];
        if (videosAdded > 0) {
          parts.push(
            t(videosAdded === 1 ? "media.drop.countVideo" : "media.drop.countVideos", {
              count: videosAdded,
            }),
          );
        }
        if (photosAdded > 0) {
          parts.push(
            t(photosAdded === 1 ? "media.drop.countPhoto" : "media.drop.countPhotos", {
              count: photosAdded,
            }),
          );
        }
        const partsJoined = parts.join(", ");
        setStatusMsg(t("media.drop.added", { parts: partsJoined }));

        onImported?.({ videosAdded, photosAdded });

        const cfg = useConfigStore.getState().config;
        const willAutoScan = shouldAutoQrAfterImport({
          videoPaths: newVideoPaths,
          photoPaths: newPhotoPaths,
          qrCheckEnabled: cfg?.qr_check_enabled,
          photoQrCheckEnabled: cfg?.photo_qr_check_enabled,
        });

        if (willAutoScan) {
          setExpanding(false);
          clearManualImportProgress();
          setQrBusy(true);
          try {
            const scanPaths = [...newVideoPaths, ...newPhotoPaths];
            const outcome = await withQrScanProgress(scanPaths, () =>
              runAutoQrAfterImport({
                videoPaths: newVideoPaths,
                photoPaths: newPhotoPaths,
                onBeforeRemoveVideo: (p) => onRemoveVideo?.(p),
              }),
            );
            if (outcome.attempted && outcome.found) {
              const qrActions = outcome.successOptions?.actions ?? [];
              showSuccess("", outcome.successTitle ?? t("app.qr.recognized"), {
                ...outcome.successOptions,
                variant: "qr",
                highlight:
                  outcome.successOptions?.highlight ||
                  outcome.kundeName ||
                  t("app.sd.customerRecognized"),
                autoCloseSecs: outcome.successOptions?.autoCloseSecs ?? 5,
                actions: [
                  ...qrActions,
                  {
                    kind: "import",
                    label: t("app.import.label"),
                    tone: "success",
                    summary: t("app.import.summary", {
                      videos: videosAdded,
                      photos: photosAdded,
                    }),
                  },
                ],
              });
              setStatusMsg(
                outcome.applied
                  ? t("media.drop.qrApplied", { parts: partsJoined })
                  : outcome.keptExisting
                    ? t("media.drop.keptCustomer", { parts: partsJoined })
                    : t("media.drop.qrSuffix", { parts: partsJoined }),
              );
            } else if (outcome.attempted && outcome.cancelled) {
              showWarning(
                outcome.message || t("app.qr.cancelled"),
                t("media.drop.qrScanTitle"),
                { autoCloseSecs: 5 },
              );
              setStatusMsg(t("media.drop.qrCancelled", { parts: partsJoined }));
            } else {
              if (outcome.attempted && outcome.message) {
                setStatusMsg(
                  t("media.drop.withMessage", {
                    parts: partsJoined,
                    message: outcome.message,
                  }),
                );
              }
              requestKundenIdFocusAfterImport({
                scanned: true,
                attempted: outcome.attempted,
                found: outcome.found,
                cancelled: outcome.cancelled,
              });
            }
          } catch (e) {
            showError(String(e), t("media.drop.autoQrTitle"));
            requestKundenIdFocus();
          } finally {
            setQrBusy(false);
          }
        } else {
          requestKundenIdFocusAfterImport({ scanned: false });
        }
      } catch (e) {
        setStatusMsg(null);
        if (isImportCancellation(e)) {
          showWarning(t("media.drop.importCancelled"), t("media.drop.importTitle"));
        } else {
          showError(String(e), t("media.drop.importTitle"));
        }
      } finally {
        setExpanding(false);
        clearManualImportProgress();
      }
    },
    [
      addPhotos,
      addVideos,
      clearError,
      clearManualImportProgress,
      onImported,
      onRemoveVideo,
      showError,
      showSuccess,
      t,
    ],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            if (!dropLockedRef.current) setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            if (dropLockedRef.current) return;
            void handlePaths(event.payload.paths);
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch(() => {
          /* not running inside Tauri webview */
        });
    } catch {
      /* browser preview without Tauri IPC */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handlePaths]);

  async function pickFiles() {
    clearError();
    setStatusMsg(null);
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: t("media.drop.filterMedia"),
          extensions: [...VIDEO_EXTENSIONS, ...PHOTO_EXTENSIONS],
        },
        { name: t("common.labels.video"), extensions: [...VIDEO_EXTENSIONS] },
        { name: t("common.labels.photos"), extensions: [...PHOTO_EXTENSIONS] },
      ],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      await handlePaths(selected);
    } else if (typeof selected === "string") {
      await handlePaths([selected]);
    }
  }

  async function pickFolder() {
    clearError();
    setStatusMsg(null);
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (typeof selected === "string" && selected.length > 0) {
      await handlePaths([selected]);
    }
  }

  async function scanAllVideos() {
    const paths = videoList.map((v) => v.path);
    if (paths.length === 0) {
      showWarning(t("media.drop.pleaseAddVideos"), t("media.drop.qrScanTitle"));
      return;
    }
    setQrBusy(true);
    try {
      const result = await withQrScanProgress(paths, () => scanQrVideos(paths));
      if (result.cancelled) {
        showWarning(result.message, t("media.drop.qrScanTitle"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path,
          preview: result.preview,
          runCleanup: () =>
            maybeRemoveQrVideo(result.source_path, {
              onBeforeRemove: (p) => onRemoveVideo?.(p),
            }),
        });
      } else {
        showWarning(result.message || t("media.drop.noQr"), t("media.drop.qrScanTitle"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("media.drop.qrScanTitle"));
      requestKundenIdFocus();
    } finally {
      setQrBusy(false);
    }
  }

  async function scanAllPhotos() {
    const paths = photoList.map((p) => p.path);
    if (paths.length === 0) {
      showWarning(t("media.drop.pleaseAddPhotos"), t("media.drop.qrScanTitle"));
      return;
    }
    setQrBusy(true);
    try {
      const edge = photoEdgeScanPaths(paths);
      const result = await withQrScanProgress(
        edge.paths,
        () => scanQrPhotos(paths),
        "scanning_photos",
        { photoEdgeLimited: edge.limited },
      );
      if (result.cancelled) {
        showWarning(result.message, t("media.drop.qrScanTitle"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path,
          preview: result.preview,
          runCleanup: () => maybeRemoveQrPhoto(result.source_path),
        });
      } else {
        showWarning(result.message || t("media.drop.noQr"), t("media.drop.qrScanTitle"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("media.drop.qrScanTitle"));
      requestKundenIdFocus();
    } finally {
      setQrBusy(false);
    }
  }

  /** Pick an external photo/video for QR only — never adds it to the media lists. */
  async function scanExternalMediaFile() {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: t("media.drop.filterPhotoOrVideo"),
          extensions: [...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS],
        },
        { name: t("common.labels.photos"), extensions: [...PHOTO_EXTENSIONS] },
        { name: t("common.labels.video"), extensions: [...VIDEO_EXTENSIONS] },
      ],
    });
    if (typeof selected !== "string") return;

    const kind = mediaKind(selected);
    if (!kind) {
      showWarning(t("media.drop.pickMedia"), t("media.drop.qrScanTitle"));
      return;
    }

    setQrBusy(true);
    try {
      const result = await withQrScanProgress([selected], () =>
        kind === "video" ? scanQrVideo(selected) : scanQrPhoto(selected),
      );
      if (result.cancelled) {
        showWarning(result.message, t("media.drop.qrScanTitle"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        const typeLabel =
          kind === "video" ? t("common.labels.video") : t("common.labels.photo");
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: selected,
          preview: result.preview,
          notes: [t("media.drop.externalNote", { type: typeLabel })],
          runCleanup: async () => emptyCleanup(),
        });
      } else {
        showWarning(
          result.message ||
            (kind === "video"
              ? t("media.drop.noQrVideo")
              : t("media.drop.noQrPhoto")),
          t("media.drop.qrScanTitle"),
        );
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("media.drop.qrScanTitle"));
      requestKundenIdFocus();
    } finally {
      setQrBusy(false);
    }
  }

  const totalCount = videoList.length + photoList.length;
  const busy = disabled || importing || photoImporting || expanding || qrBusy;
  dropLockedRef.current = busy || appendCapturesDrop;

  return (
    <section
      id={CREATE_READY_IDS.media}
      tabIndex={-1}
      className="ats-surface space-y-3 rounded-xl p-4 shadow-sm backdrop-blur-sm outline-none"
      aria-labelledby={dropZoneId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={dropZoneId}
            className="text-sm font-semibold tracking-wide text-muted uppercase"
          >
            {t("form.media.section")}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("media.drop.subtitle")}
          </p>
        </div>
        {totalCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {videoList.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                <Film className="h-3 w-3" aria-hidden />
                {t(
                  videoList.length === 1
                    ? "media.drop.countVideo"
                    : "media.drop.countVideos",
                  { count: videoList.length },
                )}
              </span>
            )}
            {photoList.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                <ImageIcon className="h-3 w-3" aria-hidden />
                {t(
                  photoList.length === 1
                    ? "media.drop.countPhoto"
                    : "media.drop.countPhotos",
                  { count: photoList.length },
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <div
        ref={qrBarRef}
        className={cn(
          "relative flex items-center gap-x-4 rounded-lg border border-border bg-card-elevated/70 px-3 py-2.5",
          wrapScanActions ? "flex-wrap gap-y-2" : "flex-nowrap",
        )}
      >
        <div
          ref={qrLeadRef}
          className="flex shrink-0 items-center gap-x-4"
        >
          <div className="flex shrink-0 items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
            <QrCode className="h-3.5 w-3.5 text-primary" aria-hidden />
            {t("media.drop.autoQr")}
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="auto-qr-videos"
                checked={autoQrVideos}
                disabled={!config || busy}
                onCheckedChange={(v) => void setAutoQrFlag("qr_check_enabled", v)}
              />
              <Label
                htmlFor="auto-qr-videos"
                className="cursor-pointer text-sm font-normal"
              >
                {t("common.labels.videos")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="auto-qr-photos"
                checked={autoQrPhotos}
                disabled={!config || busy}
                onCheckedChange={(v) =>
                  void setAutoQrFlag("photo_qr_check_enabled", v)
                }
              />
              <Label
                htmlFor="auto-qr-photos"
                className="cursor-pointer text-sm font-normal"
              >
                {t("common.labels.photos")}
              </Label>
            </div>
          </div>
        </div>
        <div
          className={cn(
            "flex items-center gap-2",
            wrapScanActions
              ? "w-full flex-wrap justify-start"
              : "ml-auto shrink-0",
          )}
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="whitespace-nowrap"
            onClick={() => void scanAllVideos()}
            disabled={busy || videoList.length === 0}
            title={
              videoList.length === 0
                ? t("media.drop.noVideos")
                : t("media.drop.scanClipsTitle", { count: videoList.length })
            }
          >
            <QrCode className="h-3.5 w-3.5" />
            {compactScanLabels
              ? t("media.drop.scanVideosCompact", { count: videoList.length })
              : t("media.drop.scanVideos", { count: videoList.length })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="whitespace-nowrap"
            onClick={() => void scanAllPhotos()}
            disabled={busy || photoList.length === 0}
            title={
              photoList.length === 0
                ? t("media.drop.noPhotos")
                : t("media.drop.scanPhotosTitle", { count: photoList.length })
            }
          >
            <QrCode className="h-3.5 w-3.5" />
            {compactScanLabels
              ? t("media.drop.scanPhotosCompact", { count: photoList.length })
              : t("media.drop.scanPhotos", { count: photoList.length })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="whitespace-nowrap"
            onClick={() => void scanExternalMediaFile()}
            disabled={busy}
            title={t("media.drop.scanExternalTitle")}
          >
            <ScanSearch className="h-3.5 w-3.5" />
            {compactScanLabels ? t("media.drop.scanFileCompact") : t("media.drop.scanFile")}
          </Button>
        </div>
        {/* Off-layout measures — pick full / compact / wrap without flicker */}
        <div
          ref={qrFullMeasureRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-2 whitespace-nowrap"
        >
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            {t("media.drop.scanVideos", { count: videoList.length })}
          </Button>
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            {t("media.drop.scanPhotos", { count: photoList.length })}
          </Button>
          <Button type="button" size="sm" variant="ghost" tabIndex={-1}>
            <ScanSearch className="h-3.5 w-3.5" />
            {t("media.drop.scanFile")}
          </Button>
        </div>
        <div
          ref={qrCompactMeasureRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-2 whitespace-nowrap"
        >
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            {t("media.drop.scanVideosCompact", { count: videoList.length })}
          </Button>
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            {t("media.drop.scanPhotosCompact", { count: photoList.length })}
          </Button>
          <Button type="button" size="sm" variant="ghost" tabIndex={-1}>
            <ScanSearch className="h-3.5 w-3.5" />
            {t("media.drop.scanFileCompact")}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "relative overflow-hidden rounded-xl border-2 border-dashed px-4 py-4 text-center transition-[border-color,background-color,box-shadow,transform] duration-200",
          dragOver
            ? "scale-[1.01] border-primary bg-primary-soft shadow-[inset_0_0_0_1px] shadow-primary/30"
            : "border-border bg-card-elevated/60 hover:border-primary/40 hover:bg-card-elevated",
        )}
        role="region"
        aria-label={t("media.drop.aria")}
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200",
            dragOver && "opacity-100",
          )}
          aria-hidden
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--ats-primary-soft),transparent_70%)]" />
        </div>

        <div className="relative">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/15">
            {dragOver ? (
              <Upload className="h-5 w-5 animate-pulse" aria-hidden />
            ) : (
              <Images className="h-5 w-5" aria-hidden />
            )}
          </div>
          <p className="mb-0.5 text-sm font-medium text-foreground">
            {dragOver ? t("media.drop.release") : t("media.drop.drag")}
          </p>
          <p className="mb-3 text-xs text-muted">
            {t("media.drop.formats")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" size="sm" onClick={() => void pickFiles()} disabled={busy}>
              {t("media.drop.pickFiles")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void pickFolder()}
              disabled={busy}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("media.drop.pickFolder")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                clearVideos({ deleteFiles: false });
                clearPhotos({ deleteFiles: false });
                void clearWorkingSession();
                onSessionCleared?.();
                setStatusMsg(null);
              }}
              disabled={busy || totalCount === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("media.drop.clearAll")}
            </Button>
          </div>
          {busy && (
            <p className="mt-2 text-sm text-muted">
              {expanding
                ? t("media.drop.searchingFolder")
                : qrBusy
                  ? t("media.drop.searchingQr")
                  : t("media.drop.importing")}
            </p>
          )}
          {importError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {importError}
            </p>
          )}
          {statusMsg && !importError && (
            <p className="mt-2 text-sm text-success" role="status">
              {statusMsg}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** @deprecated Use MediaDropZone — kept for import compatibility */
export const VideoDropZone = MediaDropZone;
