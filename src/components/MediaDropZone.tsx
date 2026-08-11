import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Film,
  FolderOpen,
  GripVertical,
  ImageIcon,
  Images,
  QrCode,
  ScanSearch,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useVideoStore } from "../store/videoStore";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useConfigStore } from "../store/configStore";
import { useUiStore } from "../store/uiStore";
import { withQrScanProgress } from "../store/qrScanStore";
import type { VideoMetadata } from "../lib/tauri";
import {
  clearWorkingSession,
  expandMediaPaths,
  scanQrPhoto,
  scanQrPhotos,
  scanQrVideo,
  scanQrVideos,
} from "../lib/tauri";
import { formatCameraLabel } from "../lib/cameraLabel";
import {
  maybeRemoveQrPhoto,
  maybeRemoveQrVideo,
} from "../lib/qrCleanup";
import { formatQrSuccess } from "../lib/qrSuccess";
import { pathsAddedSince, runAutoQrAfterImport } from "../lib/autoQrScan";
import {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  mediaKind,
  splitMediaPaths,
} from "../lib/media";
import { QrScanRowBar } from "../hooks/useQrScanProgress";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn } from "@/lib/utils";

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "?:??";
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatLabel(v: VideoMetadata): string {
  const res = v.height > 0 ? `${v.height}p` : "—";
  const fps = v.fps > 0 ? `@${Math.round(v.fps)}` : "";
  return `${res}${fps}`;
}

type SortableRowProps = {
  video: VideoMetadata;
  index: number;
  onRemove: (path: string) => void;
  onScanQr: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string) => void;
  qrBusy: boolean;
  showWatermark?: boolean;
  watermarkSelected?: boolean;
  onToggleWatermark?: (index: number) => void;
  cutMark?: "trim" | "split" | null;
};

function SortableVideoRow({
  video,
  index,
  onRemove,
  onScanQr,
  onContextMenu,
  qrBusy,
  showWatermark,
  watermarkSelected,
  onToggleWatermark,
  cutMark,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: video.path });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
  };
  const device = formatCameraLabel(video.camera_make, video.camera_model);

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={cn(
        "group border-b border-border/70 text-sm last:border-0",
        isDragging && "bg-primary-soft",
      )}
      onContextMenu={(e) => onContextMenu(e, video.path)}
    >
      <td
        className="w-8 cursor-grab px-2 py-2 text-muted active:cursor-grabbing"
        {...attributes}
        {...listeners}
        title="Ziehen zum Sortieren"
      >
        <GripVertical className="h-4 w-4" />
      </td>
      <td className="w-8 px-1 py-2 tabular-nums text-muted">{index + 1}</td>
      <td className="max-w-[12rem] px-2 py-2 font-medium" title={video.path}>
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 truncate">{video.filename}</div>
          {cutMark ? (
            <span
              className="shrink-0 rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white"
              title={cutMark === "trim" ? "Getrimmt" : "Geteilt"}
            >
              {cutMark === "trim" ? "Trim" : "Split"}
            </span>
          ) : null}
        </div>
        {device ? (
          <div className="truncate text-xs text-muted" title={device}>
            {device}
          </div>
        ) : null}
        <QrScanRowBar path={video.path} />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-muted">{formatLabel(video)}</td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
        {formatDuration(video.duration_secs)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
        {formatSize(video.size_bytes)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 font-mono text-xs text-muted">
        {video.codec}
      </td>
      {showWatermark ? (
        <td className="w-10 px-1 py-2 text-center">
          <Checkbox
            checked={Boolean(watermarkSelected)}
            onCheckedChange={() => onToggleWatermark?.(index)}
            aria-label="Wasserzeichen-Clip"
            title="Clip für Preview_Video (Wasserzeichen)"
          />
        </td>
      ) : null}
      <td className="w-[4.5rem] px-1 py-2">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted hover:text-primary"
            onClick={() => onScanQr(video.path)}
            disabled={qrBusy}
            title="QR in diesem Clip scannen"
            aria-label="QR scannen"
          >
            <QrCode className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted hover:text-destructive"
            onClick={() => onRemove(video.path)}
            title="Entfernen"
            aria-label="Entfernen"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export type MediaImportSummary = {
  videosAdded: number;
  photosAdded: number;
};

export function MediaDropZone({
  onRemoveVideo,
  onCutVideo,
  onUndoVideoCut,
  onSessionCleared,
  onImported,
  listTab,
  onListTabChange,
  disabled = false,
}: {
  onRemoveVideo?: (path: string) => void;
  /** Open cutter for a video from the list context menu */
  onCutVideo?: (path: string) => void;
  /** Undo trim/split for a video from the list context menu */
  onUndoVideoCut?: (path: string) => void;
  /** Fired when the user clears all media (working session wiped). */
  onSessionCleared?: () => void;
  /** Fired after a successful import (for preview-tab switching). */
  onImported?: (summary: MediaImportSummary) => void;
  listTab?: "video" | "foto";
  onListTabChange?: (tab: "video" | "foto") => void;
  /** External lock (e.g. SD auto workflow) — disables import / list actions. */
  disabled?: boolean;
}) {
  const videoList = useVideoStore((s) => s.videoList);
  const getCutMark = useVideoStore((s) => s.getCutMark);
  const cutMarks = useVideoStore((s) => s.cutMarks);
  const importing = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const importError = useVideoStore((s) => s.importError);
  const addVideos = useVideoStore((s) => s.addVideos);
  const removeVideo = useVideoStore((s) => s.removeVideo);
  const reorderVideos = useVideoStore((s) => s.reorderVideos);
  const sortVideos = useVideoStore((s) => s.sortVideos);
  const listSort = useVideoStore((s) => s.listSort);
  const clearVideos = useVideoStore((s) => s.clearVideos);
  const clearError = useVideoStore((s) => s.clearError);

  const photoList = usePhotoStore((s) => s.photoList);
  const addPhotos = usePhotoStore((s) => s.addPhotos);
  const removePhotos = usePhotoStore((s) => s.removePhotos);
  const clearPhotos = usePhotoStore((s) => s.clearPhotos);

  const applyFromQr = useKundeStore((s) => s.applyFromQr);
  const kunde = useKundeStore((s) => s.kunde);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const toggleWatermarkClip = useVideoStore((s) => s.toggleWatermarkClip);
  const ensureDefaultWatermarkClip = useVideoStore((s) => s.ensureDefaultWatermarkClip);
  const clearVideoWatermark = useVideoStore((s) => s.clearWatermarkSelection);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);
  const togglePhotoWatermark = usePhotoStore((s) => s.toggleWatermark);
  const clearPhotoWatermark = usePhotoStore((s) => s.clearWatermarkSelection);
  const config = useConfigStore((s) => s.config);
  const persistConfig = useConfigStore((s) => s.persist);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);

  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);
  const dropLockedRef = useRef(false);

  function openMediaMenu(e: MouseEvent, path: string) {
    mediaContextMenuHandler(path, setCtxMenu)(e);
  }

  const [dragOver, setDragOver] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [internalTab, setInternalTab] = useState<"video" | "foto">("video");
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

  function toggleVideoColumnSort(key: "name" | "duration" | "size") {
    const nextAsc = listSort?.key === key ? !listSort.asc : true;
    sortVideos(key, nextAsc);
  }

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

  const activeTab = listTab ?? internalTab;
  const setActiveTab = useCallback(
    (tab: "video" | "foto") => {
      onListTabChange?.(tab);
      if (listTab == null) setInternalTab(tab);
    },
    [listTab, onListTabChange],
  );

  async function setAutoQrFlag(
    key: "qr_check_enabled" | "photo_qr_check_enabled",
    value: boolean,
  ) {
    if (!config) return;
    const next = { ...config, [key]: value };
    const saved = await persistConfig(next);
    if (!saved) {
      showError("Einstellung konnte nicht gespeichert werden.");
    }
  }

  const handlePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      clearError();
      setStatusMsg(null);
      setExpanding(true);

      try {
        const expanded = await expandMediaPaths(paths);
        const { videos, photos, skipped } = splitMediaPaths(expanded);
        const beforeVideoPaths = useVideoStore.getState().videoList.map((v) => v.path);
        const beforePhotoPaths = usePhotoStore.getState().photoList.map((p) => p.path);

        if (videos.length > 0) {
          await addVideos(videos);
        }
        if (photos.length > 0) {
          await addPhotos(photos);
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
            setStatusMsg("Keine unterstützten Video- oder Foto-Dateien gefunden");
          } else {
            setStatusMsg("Alle Dateien sind bereits in der Liste");
          }
          return;
        }

        const parts: string[] = [];
        if (videosAdded > 0) {
          parts.push(`${videosAdded} Video${videosAdded === 1 ? "" : "s"}`);
        }
        if (photosAdded > 0) {
          parts.push(`${photosAdded} Foto${photosAdded === 1 ? "" : "s"}`);
        }
        setStatusMsg(`${parts.join(", ")} hinzugefügt`);

        if (photosAdded > 0 && videosAdded === 0) {
          setActiveTab("foto");
        } else if (videosAdded > 0) {
          setActiveTab("video");
        }

        onImported?.({ videosAdded, photosAdded });

        const cfg = useConfigStore.getState().config;
        const willAutoScan =
          (cfg?.qr_check_enabled && newVideoPaths.length > 0) ||
          (cfg?.photo_qr_check_enabled && newPhotoPaths.length > 0);

        if (willAutoScan) {
          setExpanding(false);
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
              showSuccess("", outcome.successTitle ?? "QR-Code erkannt", {
                ...outcome.successOptions,
                variant: "qr",
                highlight:
                  outcome.successOptions?.highlight ||
                  outcome.kundeName ||
                  "Kunde erkannt",
                autoCloseSecs: outcome.successOptions?.autoCloseSecs ?? 5,
                actions: [
                  ...qrActions,
                  {
                    kind: "import",
                    label: "Import",
                    tone: "success",
                    summary: `${videosAdded} Videos, ${photosAdded} Fotos`,
                  },
                ],
              });
              setStatusMsg(`${parts.join(", ")} · QR übernommen`);
            } else if (outcome.attempted && outcome.message) {
              setStatusMsg(`${parts.join(", ")} · ${outcome.message}`);
            }
          } catch (e) {
            showError(String(e), "Auto-QR");
          } finally {
            setQrBusy(false);
          }
        }
      } catch (e) {
        setStatusMsg(null);
        showError(String(e), "Import");
      } finally {
        setExpanding(false);
      }
    },
    [
      addPhotos,
      addVideos,
      clearError,
      onImported,
      onRemoveVideo,
      setActiveTab,
      showError,
      showSuccess,
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
          name: "Medien",
          extensions: [...VIDEO_EXTENSIONS, ...PHOTO_EXTENSIONS],
        },
        { name: "Video", extensions: [...VIDEO_EXTENSIONS] },
        { name: "Fotos", extensions: [...PHOTO_EXTENSIONS] },
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

  async function scanVideoQr(path: string) {
    setQrBusy(true);
    try {
      const result = await withQrScanProgress([path], () => scanQrVideo(path));
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path ?? path,
        });
        const cleanup = maybeRemoveQrVideo(result.source_path ?? path, {
          onBeforeRemove: (p) => onRemoveVideo?.(p),
        });
        const success = formatQrSuccess({
          kunde: result.kunde,
          cleanup,
          sourcePath: result.source_path ?? path,
          preview: result.preview,
        });
        showSuccess(success.message, success.title, success.options);
      } else {
        showWarning(result.message || "Kein QR-Code in diesem Clip.", "QR-Scan");
      }
    } catch (e) {
      showError(String(e), "QR-Scan");
    } finally {
      setQrBusy(false);
    }
  }

  async function scanPhotoQr(path: string) {
    setQrBusy(true);
    try {
      const result = await withQrScanProgress([path], () => scanQrPhoto(path));
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path ?? path,
        });
        const cleanup = await maybeRemoveQrPhoto(result.source_path ?? path);
        const success = formatQrSuccess({
          kunde: result.kunde,
          cleanup,
          sourcePath: result.source_path ?? path,
          preview: result.preview,
        });
        showSuccess(success.message, success.title, success.options);
      } else {
        showWarning(result.message || "Kein QR-Code in diesem Foto.", "QR-Scan");
      }
    } catch (e) {
      showError(String(e), "QR-Scan");
    } finally {
      setQrBusy(false);
    }
  }

  async function scanAllVideos() {
    const paths = videoList.map((v) => v.path);
    if (paths.length === 0) {
      showWarning("Bitte zuerst Videos in die Liste legen.", "QR-Scan");
      return;
    }
    setQrBusy(true);
    try {
      const result = await withQrScanProgress(paths, () => scanQrVideos(paths));
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path,
        });
        const cleanup = maybeRemoveQrVideo(result.source_path, {
          onBeforeRemove: (p) => onRemoveVideo?.(p),
        });
        const success = formatQrSuccess({
          kunde: result.kunde,
          cleanup,
          sourcePath: result.source_path,
          preview: result.preview,
        });
        showSuccess(success.message, success.title, success.options);
      } else {
        showWarning(result.message || "Kein gültiger QR-Code gefunden.", "QR-Scan");
      }
    } catch (e) {
      showError(String(e), "QR-Scan");
    } finally {
      setQrBusy(false);
    }
  }

  async function scanAllPhotos() {
    const paths = photoList.map((p) => p.path);
    if (paths.length === 0) {
      showWarning("Bitte zuerst Fotos in die Liste legen.", "QR-Scan");
      return;
    }
    setQrBusy(true);
    try {
      const result = await withQrScanProgress(paths, () => scanQrPhotos(paths));
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path,
        });
        const cleanup = await maybeRemoveQrPhoto(result.source_path);
        const success = formatQrSuccess({
          kunde: result.kunde,
          cleanup,
          sourcePath: result.source_path,
          preview: result.preview,
        });
        showSuccess(success.message, success.title, success.options);
      } else {
        showWarning(result.message || "Kein gültiger QR-Code gefunden.", "QR-Scan");
      }
    } catch (e) {
      showError(String(e), "QR-Scan");
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
          name: "Foto oder Video",
          extensions: [...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS],
        },
        { name: "Fotos", extensions: [...PHOTO_EXTENSIONS] },
        { name: "Video", extensions: [...VIDEO_EXTENSIONS] },
      ],
    });
    if (typeof selected !== "string") return;

    const kind = mediaKind(selected);
    if (!kind) {
      showWarning("Bitte eine Foto- oder Video-Datei wählen.", "QR-Scan");
      return;
    }

    setQrBusy(true);
    try {
      const result = await withQrScanProgress([selected], () =>
        kind === "video" ? scanQrVideo(selected) : scanQrPhoto(selected),
      );
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: selected,
        });
        const typeLabel = kind === "video" ? "Video" : "Foto";
        const success = formatQrSuccess({
          kunde: result.kunde,
          sourcePath: selected,
          notes: [`Externes ${typeLabel} — Datei nicht importiert.`],
          preview: result.preview,
        });
        showSuccess(success.message, success.title, success.options);
      } else {
        showWarning(
          result.message ||
            (kind === "video"
              ? "Kein gültiger QR-Code im Video."
              : "Kein gültiger QR-Code im Foto."),
          "QR-Scan",
        );
      }
    } catch (e) {
      showError(String(e), "QR-Scan");
    } finally {
      setQrBusy(false);
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorderVideos(String(active.id), String(over.id));
  }

  const totalCount = videoList.length + photoList.length;
  const busy = disabled || importing || photoImporting || expanding || qrBusy;
  dropLockedRef.current = busy;

  return (
    <section
      className="ats-surface space-y-3 rounded-xl p-4 shadow-sm backdrop-blur-sm"
      aria-labelledby={dropZoneId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={dropZoneId}
            className="text-sm font-semibold tracking-wide text-muted uppercase"
          >
            Medien
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Import per Drag & Drop, Datei- oder Ordnerwahl
          </p>
        </div>
        {totalCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {videoList.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                <Film className="h-3 w-3" aria-hidden />
                {videoList.length}
              </span>
            )}
            {photoList.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                <ImageIcon className="h-3 w-3" aria-hidden />
                {photoList.length}
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
            Auto-QR beim Import
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
                Videos
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
                Fotos
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
                ? "Keine Videos in der Liste"
                : `${videoList.length} Clip(s) parallel scannen`
            }
          >
            <QrCode className="h-3.5 w-3.5" />
            {compactScanLabels
              ? `Videos (${videoList.length})`
              : `Videos scannen (${videoList.length})`}
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
                ? "Keine Fotos in der Liste"
                : `${photoList.length} Foto(s) parallel scannen`
            }
          >
            <QrCode className="h-3.5 w-3.5" />
            {compactScanLabels
              ? `Fotos (${photoList.length})`
              : `Fotos scannen (${photoList.length})`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="whitespace-nowrap"
            onClick={() => void scanExternalMediaFile()}
            disabled={busy}
            title="Foto oder Video wählen — nur QR-Scan, kein Import"
          >
            <ScanSearch className="h-3.5 w-3.5" />
            {compactScanLabels ? "Datei…" : "Datei scannen…"}
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
            Videos scannen ({videoList.length})
          </Button>
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            Fotos scannen ({photoList.length})
          </Button>
          <Button type="button" size="sm" variant="ghost" tabIndex={-1}>
            <ScanSearch className="h-3.5 w-3.5" />
            Datei scannen…
          </Button>
        </div>
        <div
          ref={qrCompactMeasureRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-2 whitespace-nowrap"
        >
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            Videos ({videoList.length})
          </Button>
          <Button type="button" size="sm" variant="secondary" tabIndex={-1}>
            <QrCode className="h-3.5 w-3.5" />
            Fotos ({photoList.length})
          </Button>
          <Button type="button" size="sm" variant="ghost" tabIndex={-1}>
            <ScanSearch className="h-3.5 w-3.5" />
            Datei…
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "relative overflow-hidden rounded-xl border-2 border-dashed px-4 py-7 text-center transition-[border-color,background-color,box-shadow,transform] duration-200",
          dragOver
            ? "scale-[1.01] border-primary bg-primary-soft shadow-[inset_0_0_0_1px] shadow-primary/30"
            : "border-border bg-card-elevated/60 hover:border-primary/40 hover:bg-card-elevated",
        )}
        role="region"
        aria-label="Videos, Fotos und Ordner hierher ziehen"
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
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/15">
            {dragOver ? (
              <Upload className="h-6 w-6 animate-pulse" aria-hidden />
            ) : (
              <Images className="h-6 w-6" aria-hidden />
            )}
          </div>
          <p className="mb-1 text-sm font-medium text-foreground">
            {dragOver
              ? "Loslassen zum Hinzufügen"
              : "Dateien oder Ordner hierher ziehen"}
          </p>
          <p className="mb-4 text-xs text-muted">
            Ordner werden rekursiv durchsucht · .mp4, .mov · .jpg, .png, .webp …
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" size="sm" onClick={() => void pickFiles()} disabled={busy}>
              Dateien wählen…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void pickFolder()}
              disabled={busy}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Ordner wählen…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                clearVideos();
                clearPhotos();
                void clearWorkingSession();
                onSessionCleared?.();
                setStatusMsg(null);
              }}
              disabled={busy || totalCount === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Alles leeren
            </Button>
          </div>
          {busy && (
            <p className="mt-3 text-sm text-muted">
              {expanding ? "Ordner werden durchsucht…" : "Importiere…"}
            </p>
          )}
          {importError && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {importError}
            </p>
          )}
          {statusMsg && !importError && (
            <p className="mt-3 text-sm text-success" role="status">
              {statusMsg}
            </p>
          )}
        </div>
      </div>

      {totalCount > 0 && (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v === "foto" ? "foto" : "video")}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList className="h-9">
              <TabsTrigger value="video" className="gap-1.5 text-xs">
                <Film className="h-3.5 w-3.5" />
                Videos
                {videoList.length > 0 && (
                  <span className="tabular-nums text-muted">({videoList.length})</span>
                )}
              </TabsTrigger>
              <TabsTrigger value="foto" className="gap-1.5 text-xs">
                <ImageIcon className="h-3.5 w-3.5" />
                Fotos
                {photoList.length > 0 && (
                  <span className="tabular-nums text-muted">({photoList.length})</span>
                )}
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-xs text-muted"
              disabled={busy}
              onClick={() => {
                if (activeTab === "video") clearVideos();
                else clearPhotos();
                setStatusMsg(null);
              }}
            >
              {activeTab === "video" ? "Videos leeren" : "Fotos leeren"}
            </Button>
          </div>

          <TabsContent value="video" className="mt-3">
            {videoList.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                Noch keine Videos — oben ablegen oder wählen
              </p>
            ) : (
              <div className="max-h-[18rem] overflow-auto rounded-lg border border-border bg-card">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="sticky top-0 z-[1] border-b border-border bg-card-elevated text-left text-xs font-semibold tracking-wide text-muted uppercase">
                        <th className="px-2 py-2" aria-label="Sortieren" />
                        <th className="px-1 py-2">#</th>
                        <th className="px-2 py-2">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                              listSort?.key === "name" && "text-foreground",
                            )}
                            onClick={() => toggleVideoColumnSort("name")}
                            title="Nach Dateiname sortieren"
                          >
                            Dateiname
                            {listSort?.key === "name" ? (
                              listSort.asc ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              )
                            ) : null}
                          </button>
                        </th>
                        <th className="px-2 py-2">Format</th>
                        <th className="px-2 py-2">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                              listSort?.key === "duration" && "text-foreground",
                            )}
                            onClick={() => toggleVideoColumnSort("duration")}
                            title="Nach Dauer sortieren"
                          >
                            Dauer
                            {listSort?.key === "duration" ? (
                              listSort.asc ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              )
                            ) : null}
                          </button>
                        </th>
                        <th className="px-2 py-2">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                              listSort?.key === "size" && "text-foreground",
                            )}
                            onClick={() => toggleVideoColumnSort("size")}
                            title="Nach Größe sortieren"
                          >
                            Größe
                            {listSort?.key === "size" ? (
                              listSort.asc ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              )
                            ) : null}
                          </button>
                        </th>
                        <th className="px-2 py-2">Codec</th>
                        {videoWmNeeded ? (
                          <th className="px-1 py-2 text-center" title="Wasserzeichen">
                            WM
                          </th>
                        ) : null}
                        <th className="px-1 py-2 text-right" aria-label="Aktionen">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <SortableContext
                        items={videoList.map((v) => v.path)}
                        strategy={verticalListSortingStrategy}
                      >
                        {videoList.map((v, i) => {
                          void cutMarks;
                          return (
                          <SortableVideoRow
                            key={v.path}
                            video={v}
                            index={i}
                            qrBusy={qrBusy || busy}
                            showWatermark={videoWmNeeded}
                            watermarkSelected={watermarkClipIndex === i}
                            onToggleWatermark={toggleWatermarkClip}
                            cutMark={getCutMark(v.path)}
                            onScanQr={(path) => void scanVideoQr(path)}
                            onContextMenu={openMediaMenu}
                            onRemove={(path) => {
                              onRemoveVideo?.(path);
                              removeVideo(path);
                            }}
                          />
                          );
                        })}
                      </SortableContext>
                    </tbody>
                  </table>
                </DndContext>
              </div>
            )}
          </TabsContent>

          <TabsContent value="foto" className="mt-3">
            {photoList.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                Noch keine Fotos — oben ablegen oder wählen
              </p>
            ) : (
              <div className="max-h-[18rem] overflow-auto rounded-lg border border-border bg-card">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="sticky top-0 z-[1] border-b border-border bg-card-elevated text-left text-xs font-semibold tracking-wide text-muted uppercase">
                      <th className="px-2 py-2">#</th>
                      <th className="px-2 py-2">Dateiname</th>
                      {fotoWmNeeded ? (
                        <th className="px-1 py-2 text-center" title="Wasserzeichen">
                          WM
                        </th>
                      ) : null}
                      <th className="px-1 py-2 text-right" aria-label="Aktionen">
                        <span className="sr-only">Aktionen</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {photoList.map((p, i) => {
                      const device = formatCameraLabel(
                        p.camera_make,
                        p.camera_model,
                      );
                      return (
                      <tr
                        key={p.path}
                        className="border-b border-border/70 text-sm last:border-0"
                        onContextMenu={(e) => openMediaMenu(e, p.path)}
                      >
                        <td className="w-8 px-2 py-2 tabular-nums text-muted">
                          {i + 1}
                        </td>
                        <td
                          className="max-w-[20rem] px-2 py-2 font-medium"
                          title={p.path}
                        >
                          <div className="truncate">{p.filename}</div>
                          {device ? (
                            <div
                              className="truncate text-xs text-muted"
                              title={device}
                            >
                              {device}
                            </div>
                          ) : null}
                          <QrScanRowBar path={p.path} />
                        </td>
                        {fotoWmNeeded ? (
                          <td className="w-10 px-1 py-2 text-center">
                            <Checkbox
                              checked={watermarkPhotoIndices.has(i)}
                              onCheckedChange={() => togglePhotoWatermark(i)}
                              aria-label="Wasserzeichen-Foto"
                              title="Foto für Preview_Foto (Wasserzeichen)"
                            />
                          </td>
                        ) : null}
                        <td className="w-[4.5rem] px-1 py-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted hover:text-primary"
                              onClick={() => void scanPhotoQr(p.path)}
                              disabled={qrBusy || busy}
                              title="QR in diesem Foto scannen"
                              aria-label="QR scannen"
                            >
                              <QrCode className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted hover:text-destructive"
                              onClick={() => {
                                const idx = photoList.findIndex((x) => x.path === p.path);
                                if (idx >= 0) removePhotos([idx]);
                              }}
                              title="Entfernen"
                              aria-label="Entfernen"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, "Datei")}
        onCopied={() => showSuccess("Pfad in die Zwischenablage kopiert.", "Pfad")}
        actionsDisabled={qrBusy || busy}
        onScanQr={(path) => {
          if (videoList.some((v) => v.path === path)) {
            void scanVideoQr(path);
          } else {
            void scanPhotoQr(path);
          }
        }}
        onCut={
          onCutVideo && ctxMenu && videoList.some((v) => v.path === ctxMenu.path)
            ? (path) => onCutVideo(path)
            : undefined
        }
        canUndoCut={Boolean(
          ctxMenu &&
            videoList.some((v) => v.path === ctxMenu.path) &&
            getCutMark(ctxMenu.path),
        )}
        onUndoCut={onUndoVideoCut}
        onRemove={(path) => {
          if (videoList.some((v) => v.path === path)) {
            onRemoveVideo?.(path);
            removeVideo(path);
            return;
          }
          const idx = photoList.findIndex((p) => p.path === path);
          if (idx >= 0) removePhotos([idx]);
        }}
      />
    </section>
  );
}

/** @deprecated Use MediaDropZone — kept for import compatibility */
export const VideoDropZone = MediaDropZone;
