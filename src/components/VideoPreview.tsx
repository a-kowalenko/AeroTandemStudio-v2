import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Film, Play, QrCode, RefreshCw, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { ProgressIndicator } from "./ProgressIndicator";
import { VideoPlayer, type VideoPlayerHandle } from "./VideoPlayer";
import { useVideoStore } from "../store/videoStore";
import { useKundeStore } from "../store/kundeStore";
import { useUiStore } from "../store/uiStore";
import { usePreviewCacheStore, previewEncodingSignature } from "../store/previewCacheStore";
import { withQrScanProgress } from "../store/qrScanStore";
import {
  generatePreview,
  validateKunde,
  scanQrVideo,
  type PreviewResult,
  type VideoMetadata,
} from "../lib/tauri";
import { useConfigStore } from "../store/configStore";
import { QrScanRowBar } from "../hooks/useQrScanProgress";
import { maybeRemoveQrVideo } from "../lib/qrCleanup";
import { formatQrSuccess } from "../lib/qrSuccess";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn, isCancellationError } from "../lib/utils";

/** Snappy ease-out — close to iOS spring settle without extra deps. */
const CLIP_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const CLIP_MS = 220;

const clipDropAnimation: DropAnimation = {
  duration: CLIP_MS,
  easing: CLIP_EASE,
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.35" } },
  }),
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type ClipChipProps = {
  video: VideoMetadata;
  index: number;
  active: boolean;
  isWm: boolean;
  cutMark: "trim" | "split" | null;
  revision: number;
  onSelect: (index: number) => void;
  onContextMenu: (e: MouseEvent, path: string) => void;
  /** Drag overlay: no sortable bindings. */
  overlay?: boolean;
  dragging?: boolean;
};

function ClipChipFace({
  video,
  isWm,
  cutMark,
  overlay,
}: Omit<ClipChipProps, "index" | "revision" | "onSelect" | "onContextMenu" | "active" | "dragging"> & {
  overlay?: boolean;
}) {
  return (
    <>
      <div className="truncate font-medium">{video.filename}</div>
      <div className="text-muted">
        {video.width}×{video.height} · {formatDuration(video.duration_secs)}
      </div>
      {!overlay && <QrScanRowBar path={video.path} />}
      {cutMark && (
        <span
          className="absolute top-1 right-1 rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
          aria-label={cutMark === "trim" ? "Getrimmt" : "Geteilt"}
        >
          {cutMark === "trim" ? "Trim" : "Split"}
        </span>
      )}
      {isWm && (
        <span
          className={cn(
            "absolute top-1 rounded bg-amber-500 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm",
            cutMark ? "right-9" : "right-1",
          )}
          aria-label="Wasserzeichen"
        >
          WM
        </span>
      )}
    </>
  );
}

function SortableClipChip({
  video,
  index,
  active,
  isWm,
  cutMark,
  revision,
  onSelect,
  onContextMenu,
}: ClipChipProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: video.path,
    transition: {
      duration: CLIP_MS,
      easing: CLIP_EASE,
    },
  });

  // With DragOverlay: keep the source as a stationary ghost (no pointer delta).
  // Sibling chips still receive layout transforms for the snappy shuffle.
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    transition: transition ?? undefined,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(index)}
      onContextMenu={(e) => onContextMenu(e, video.path)}
      className={cn(
        "relative min-w-[7.5rem] max-w-[9rem] shrink-0 touch-none rounded-lg border px-2 py-1.5 pr-7 text-left text-xs",
        "cursor-grab active:cursor-grabbing",
        "will-change-transform",
        active
          ? "border-primary bg-primary-soft"
          : "border-border/70 bg-card/70 hover:border-primary/40",
        isDragging && "opacity-35 shadow-none",
      )}
      title={isWm ? `${video.path} (Wasserzeichen)` : video.path}
      data-revision={revision}
    >
      <ClipChipFace
        video={video}
        isWm={isWm}
        cutMark={cutMark}
      />
    </button>
  );
}

function ClipChipOverlay({
  video,
  active,
  isWm,
  cutMark,
}: {
  video: VideoMetadata;
  active: boolean;
  isWm: boolean;
  cutMark: "trim" | "split" | null;
}) {
  return (
    <div
      className={cn(
        "relative min-w-[7.5rem] max-w-[9rem] rounded-lg border px-2 py-1.5 pr-7 text-left text-xs",
        "shadow-xl ring-2 ring-primary/35",
        "cursor-grabbing",
        active
          ? "border-primary bg-primary-soft"
          : "border-border bg-card",
      )}
    >
      <ClipChipFace video={video} isWm={isWm} cutMark={cutMark} overlay />
    </div>
  );
}

type TaskProgressState = {
  taskId: number;
  percent: number;
  status: string;
};

type VideoPreviewProps = {
  /** Shared busy flag from App so Cancel works globally */
  busy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** External progress when App already listens — if omitted, listens locally */
  percent?: number;
  status?: string;
  taskProgress?: TaskProgressState[];
  onProgressReset?: () => void;
  /** Open cutter for the active clip */
  onCutClip?: (path: string, listIndex: number) => void;
  /** Undo cut/trim for one clip */
  onUndoClipCut?: (path: string) => void;
  /** Undo all cut/trim actions */
  onUndoAllCuts?: () => void;
  /** Whether any clip has an undoable cut */
  canUndoCuts?: boolean;
  /** Called before removing a clip from the list */
  onBeforeRemoveClip?: (path: string) => void;
  /**
   * Same readiness gate as „Erstellen“ (form + products).
   * When false, preview encode is blocked.
   */
  formReady?: boolean;
  /** Optional hints from create validation (shown on click / title). */
  formHints?: string[];
  /** Pause preview playback (e.g. while the cutter dialog is open). */
  playbackSuspended?: boolean;
};

export function VideoPreview({
  busy: busyProp,
  onBusyChange,
  percent: percentProp,
  status: statusProp,
  taskProgress: tasksProp,
  onProgressReset,
  onCutClip,
  onUndoClipCut,
  onUndoAllCuts,
  canUndoCuts = false,
  onBeforeRemoveClip,
  formReady = true,
  formHints = [],
  playbackSuspended = false,
}: VideoPreviewProps) {
  const videoList = useVideoStore((s) => s.videoList);
  const removeVideo = useVideoStore((s) => s.removeVideo);
  const reorderVideos = useVideoStore((s) => s.reorderVideos);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const toggleWatermarkClip = useVideoStore((s) => s.toggleWatermarkClip);
  const getCutMark = useVideoStore((s) => s.getCutMark);
  const getMediaRevision = useVideoStore((s) => s.getMediaRevision);
  const cutMarks = useVideoStore((s) => s.cutMarks);
  const kunde = useKundeStore((s) => s.kunde);
  const applyFromQr = useKundeStore((s) => s.applyFromQr);
  const oldschoolMode = useConfigStore((s) => s.config?.oldschool_mode);
  const config = useConfigStore((s) => s.config);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);
  const setPreviewCache = usePreviewCacheStore((s) => s.setFromPreview);
  const clearPreviewCache = usePreviewCacheStore((s) => s.clear);
  const previewCacheMatches = usePreviewCacheStore((s) => s.matches);

  const [localBusy, setLocalBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  /** Combined preview vs. single-clip player; preview file is kept until overwritten or list cleared. */
  const [playerMode, setPlayerMode] = useState<"combined" | "clip">("clip");
  const [activeClip, setActiveClip] = useState(0);
  /** When Einzelclip-Wiedergabe ends, advance to the next clip. */
  const [autoNextClip, setAutoNextClip] = useState(true);
  /** One-shot: play after src change (used when auto-advancing). */
  const [playOnLoad, setPlayOnLoad] = useState(false);
  const clipPlayerRef = useRef<VideoPlayerHandle>(null);
  const combinedPlayerRef = useRef<VideoPlayerHandle>(null);
  const autoNextClipRef = useRef(autoNextClip);
  autoNextClipRef.current = autoNextClip;
  const activeClipRef = useRef(activeClip);
  activeClipRef.current = activeClip;
  const [localPercent, setLocalPercent] = useState(0);
  const [localStatus, setLocalStatus] = useState("");
  const [localTasks, setLocalTasks] = useState<TaskProgressState[]>([]);
  const [qrBusy, setQrBusy] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const clipStripRef = useRef<HTMLDivElement>(null);

  const clipSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // One-shot autoplay flag — clear after the clip switch so later seeks don't re-trigger.
  useEffect(() => {
    if (!playOnLoad) return;
    const t = window.setTimeout(() => setPlayOnLoad(false), 700);
    return () => window.clearTimeout(t);
  }, [playOnLoad, activeClip]);

  // Pause clip/combined preview while the cutter (or other overlay) is open.
  useEffect(() => {
    if (!playbackSuspended) return;
    setPlayOnLoad(false);
    clipPlayerRef.current?.pause();
    combinedPlayerRef.current?.pause();
  }, [playbackSuspended]);

  // While reordering: keep page scrollbars (avoid width jump) but freeze scroll
  // position. Only the clip strip may auto-scroll via dnd-kit.
  useEffect(() => {
    if (!draggingPath) return;

    const locked: { el: HTMLElement; top: number; left: number }[] = [];
    const lock = (el: HTMLElement | null) => {
      if (!el || locked.some((l) => l.el === el)) return;
      locked.push({ el, top: el.scrollTop, left: el.scrollLeft });
    };

    lock(document.documentElement);
    lock(document.body);

    let node: HTMLElement | null = clipStripRef.current?.parentElement ?? null;
    while (node) {
      const { overflowY: oy, overflowX: ox } = getComputedStyle(node);
      const yScrollable = oy === "auto" || oy === "scroll" || oy === "overlay";
      const xScrollable = ox === "auto" || ox === "scroll" || ox === "overlay";
      if (node !== clipStripRef.current && (yScrollable || xScrollable)) {
        lock(node);
      }
      node = node.parentElement;
    }

    const pinLocked = () => {
      for (const { el, top, left } of locked) {
        if (el.scrollTop !== top) el.scrollTop = top;
        if (el.scrollLeft !== left) el.scrollLeft = left;
      }
    };

    const blockWheelTouch = (e: Event) => {
      const strip = clipStripRef.current;
      if (strip && e.target instanceof Node && strip.contains(e.target)) return;
      e.preventDefault();
      pinLocked();
    };

    window.addEventListener("scroll", pinLocked, true);
    window.addEventListener("wheel", blockWheelTouch, { passive: false });
    window.addEventListener("touchmove", blockWheelTouch, { passive: false });

    return () => {
      window.removeEventListener("scroll", pinLocked, true);
      window.removeEventListener("wheel", blockWheelTouch);
      window.removeEventListener("touchmove", blockWheelTouch);
    };
  }, [draggingPath]);

  const hasPreviewFile = Boolean(preview?.preview_path);
  const showingCombined = hasPreviewFile && playerMode === "combined";
  const einzelclipMode = !showingCombined;

  const busy = busyProp ?? localBusy;
  const percent = percentProp ?? localPercent;
  const status = statusProp ?? localStatus;
  const taskProgress = tasksProp ?? localTasks;

  const totalDuration = useMemo(
    () => videoList.reduce((sum, v) => sum + (v.duration_secs || 0), 0),
    [videoList],
  );
  const totalSize = useMemo(
    () => videoList.reduce((sum, v) => sum + (v.size_bytes || 0), 0),
    [videoList],
  );

  const videoWmNeeded =
    (kunde.handcam_video && !kunde.ist_bezahlt_handcam_video) ||
    (kunde.outside_video && !kunde.ist_bezahlt_outside_video);

  const encodingSig = previewEncodingSignature(
    Boolean(config?.intro_enabled ?? false),
    config?.dauer ?? 5,
    config?.intro_mux_mode ?? "reencode",
  );

  const previewStale = Boolean(
    preview?.preview_path &&
      !previewCacheMatches(videoList, kunde, encodingSig),
  );

  useEffect(() => {
    if (videoList.length === 0) {
      setPreview(null);
      clearPreviewCache();
      setPlayerMode("clip");
      setActiveClip(0);
      setPlayOnLoad(false);
      return;
    }
    if (activeClip >= videoList.length) {
      setActiveClip(0);
      setPlayOnLoad(false);
    }
    // Keep the last preview file when form/clips change; reuse is blocked via matches().
  }, [videoList, activeClip, clearPreviewCache]);

  function setBusy(value: boolean) {
    setLocalBusy(value);
    onBusyChange?.(value);
  }

  function resetLocalProgress() {
    setLocalPercent(0);
    setLocalStatus("starting");
    setLocalTasks([]);
    onProgressReset?.();
  }

  async function handleGenerate() {
    if (videoList.length === 0) {
      showError("Keine Videos in der Liste.");
      return;
    }
    const paths = videoList.map((v) => v.path);
    try {
      const form = await validateKunde(kunde, paths, oldschoolMode);
      if (!form.valid) {
        showWarning(form.errors.join("\n"), "Validierung");
        return;
      }
    } catch (e) {
      showError(String(e), "Validierung");
      return;
    }
    if (!formReady) {
      const hint =
        formHints.filter((h) => !h.includes("Speicherort")).join("\n") ||
        "Formular oder Produkte sind noch nicht vollständig.";
      showWarning(hint, "Validierung");
      return;
    }

    setBusy(true);
    resetLocalProgress();
    try {
      const result = await generatePreview(paths, kunde);
      setPreview(result);
      setPreviewCache(result, videoList, kunde, encodingSig);
      setPlayerMode("combined");
      setLocalPercent(100);
      setLocalStatus("end");
      const strategy =
        result.strategy === "stream_copy_only"
          ? "Stream-Copy"
          : result.strategy === "per_clip"
            ? "Pro Clip"
            : result.strategy === "combined"
              ? "Combined"
              : result.strategy;
      const reasonSuffix = result.reencode_reason
        ? `\nNeu-Kodierung: ${result.reencode_reason}`
        : "";
      showSuccess(
        result.intro_included
          ? `Kombinierte Vorschau erstellt (${strategy}, mit Intro).${reasonSuffix}`
          : `Kombinierte Vorschau erstellt (${strategy}).${reasonSuffix}`,
        "Vorschau",
        { autoCloseSecs: 5 },
      );
    } catch (e) {
      if (isCancellationError(e)) {
        setLocalStatus("cancelled");
        showWarning("Vorschau abgebrochen.");
      } else {
        showError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const canGeneratePreview = formReady && videoList.length >= 1;

  async function handleQrScan(path?: string) {
    const clip = path
      ? videoList.find((v) => v.path === path)
      : videoList[activeClip];
    if (!clip) return;
    setQrBusy(true);
    try {
      const result = await withQrScanProgress([clip.path], () => scanQrVideo(clip.path));
      if (result.cancelled) {
        showWarning(result.message, "QR-Scan");
      } else if (result.found && result.kunde) {
        applyFromQr(result.kunde, {
          preview: result.preview,
          sourcePath: result.source_path ?? clip.path,
        });
        const cleanup = maybeRemoveQrVideo(result.source_path ?? clip.path, {
          onBeforeRemove: (p) => onBeforeRemoveClip?.(p),
        });
        const success = formatQrSuccess({
          kunde: result.kunde,
          cleanup,
          sourcePath: result.source_path ?? clip.path,
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

  const current = videoList[activeClip];

  function selectClip(index: number, autoPlay = false) {
    setPlayerMode("clip");
    if (index === activeClip && autoPlay && playerMode === "clip") {
      clipPlayerRef.current?.seekMs(0);
      clipPlayerRef.current?.play();
      return;
    }
    setPlayOnLoad(autoPlay);
    setActiveClip(index);
  }

  function onClipDragStart(event: DragStartEvent) {
    setDraggingPath(String(event.active.id));
  }

  function onClipDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDraggingPath(null);
    if (!over || active.id === over.id) return;
    const keepPath = videoList[activeClip]?.path;
    reorderVideos(String(active.id), String(over.id));
    if (keepPath) {
      const next = useVideoStore
        .getState()
        .videoList.findIndex((v) => v.path === keepPath);
      if (next >= 0) setActiveClip(next);
    }
  }

  function onClipDragCancel() {
    setDraggingPath(null);
  }

  function showCombinedPreview() {
    if (!preview?.preview_path) return;
    setPlayOnLoad(false);
    setPlayerMode("combined");
  }

  function handleClipEnded() {
    if (!einzelclipMode || !autoNextClipRef.current || busy) return;
    const idx = activeClipRef.current;
    if (idx >= videoList.length - 1) return;
    selectClip(idx + 1, true);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Film className="h-4 w-4 text-primary" />
          Video-Vorschau
        </h3>
        <div className="flex flex-wrap gap-2">
          {canUndoCuts && onUndoAllCuts && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onUndoAllCuts()}
              disabled={busy}
              title="Alle Trim-/Teilen-Aktionen rückgängig machen"
            >
              <RotateCcw className="h-4 w-4" />
              Alle Schnitte rückgängig
            </Button>
          )}
          {videoList.length > 0 &&
            (!hasPreviewFile ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={busy || !canGeneratePreview}
                title={
                  canGeneratePreview
                    ? undefined
                    : formHints.filter((h) => !h.includes("Speicherort"))[0] ||
                      "Formular unvollständig"
                }
              >
                <Play className="h-4 w-4" />
                Vorschau generieren
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={showingCombined ? "default" : "secondary"}
                  onClick={showCombinedPreview}
                  disabled={busy}
                  title="Gespeicherte kombinierte Vorschau anzeigen (ohne neu zu generieren)"
                >
                  <Play className="h-4 w-4" />
                  Vorschau anzeigen
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={previewStale ? "default" : "secondary"}
                  onClick={() => void handleGenerate()}
                  disabled={busy || !canGeneratePreview}
                  title={
                    canGeneratePreview
                      ? previewStale
                        ? "Formular oder Clips haben sich geändert — Vorschau neu generieren"
                        : "Kombinierte Vorschau neu erzeugen und überschreiben"
                      : formHints.filter((h) => !h.includes("Speicherort"))[0] ||
                        "Formular unvollständig"
                  }
                >
                  <RefreshCw className="h-4 w-4" />
                  {previewStale ? "Vorschau aktualisieren" : "Neu"}
                </Button>
              </>
            ))}
        </div>
      </div>

      {previewStale && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
          role="status"
        >
          Vorschau veraltet — Formular oder Clips wurden geändert.
        </div>
      )}

      {showingCombined && preview?.preview_path ? (
        <div className={cn("relative", previewStale && "opacity-80")}>
          <VideoPlayer
            ref={combinedPlayerRef}
            srcPath={preview.preview_path}
            disabled={busy}
          />
          {previewStale && (
            <span className="pointer-events-none absolute top-2 right-2 rounded bg-amber-600/90 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
              Veraltet
            </span>
          )}
        </div>
      ) : current ? (
        <VideoPlayer
          ref={clipPlayerRef}
          srcPath={current.path}
          cacheKey={`${current.size_bytes}-${current.duration_secs}-${getMediaRevision(current.path)}`}
          disabled={busy}
          autoPlay={playOnLoad && !playbackSuspended}
          onEnded={handleClipEnded}
        />
      ) : (
        <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-[var(--ats-preview-stage)] text-sm text-white/75 ring-1 ring-border">
          <Film className="h-8 w-8 opacity-50" aria-hidden />
          <p>Keine Videos — per Drag & Drop im Medien-Bereich hinzufügen</p>
        </div>
      )}

      {einzelclipMode && current && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {hasPreviewFile
              ? "Einzelclip-Wiedergabe — „Vorschau anzeigen“ für die kombinierte Datei."
              : "Einzelclip-Wiedergabe — „Vorschau generieren“ für die kombinierte Datei."}
          </p>
          <div className="flex items-center gap-2">
            <Switch
              id="auto-next-clip"
              checked={autoNextClip}
              onCheckedChange={setAutoNextClip}
              disabled={busy || videoList.length < 2}
            />
            <Label
              htmlFor="auto-next-clip"
              className="cursor-pointer text-xs font-normal text-muted"
            >
              Nächsten Clip automatisch abspielen
            </Label>
          </div>
        </div>
      )}

      {(busy || percent > 0 || taskProgress.length > 0) && percentProp == null && (
        <ProgressIndicator
          percent={percent}
          label={busy ? `Vorschau… (${status})` : `Fertig (${status})`}
          tasks={taskProgress.map((t) => ({
            taskId: t.taskId,
            percent: t.percent,
            status: t.status,
          }))}
        />
      )}

      {videoList.length > 0 && (
        <DndContext
          sensors={clipSensors}
          collisionDetection={closestCenter}
          onDragStart={onClipDragStart}
          onDragEnd={onClipDragEnd}
          onDragCancel={onClipDragCancel}
          autoScroll={{
            threshold: { x: 0.18, y: 0 },
            // Only the horizontal clip strip — never the window / main view.
            canScroll: (el) => el === clipStripRef.current,
          }}
        >
          <div
            ref={clipStripRef}
            data-clip-carousel
            className="flex gap-2 overflow-x-auto overscroll-x-contain pb-5"
          >
            <SortableContext
              items={videoList.map((v) => v.path)}
              strategy={horizontalListSortingStrategy}
            >
              {videoList.map((v, i) => {
                const isWm = videoWmNeeded && watermarkClipIndex === i;
                const clipActive = einzelclipMode && i === activeClip;
                const cutMark = getCutMark(v.path);
                // Subscribe to cutMarks so chips update
                void cutMarks;
                return (
                  <SortableClipChip
                    key={v.path}
                    video={v}
                    index={i}
                    active={clipActive}
                    isWm={isWm}
                    cutMark={cutMark}
                    revision={getMediaRevision(v.path)}
                    onSelect={(idx) => selectClip(idx, autoNextClip)}
                    onContextMenu={(e, path) =>
                      mediaContextMenuHandler(path, setCtxMenu)(e)
                    }
                  />
                );
              })}
            </SortableContext>
            {hasPreviewFile && (
              <button
                type="button"
                onClick={showCombinedPreview}
                disabled={busy}
                className={cn(
                  "relative min-w-[7.5rem] max-w-[9rem] shrink-0 rounded-lg border px-2 py-1.5 text-left text-xs transition",
                  showingCombined
                    ? "border-primary bg-primary-soft"
                    : "border-border/70 bg-card/70 hover:border-primary/40",
                )}
                title={
                  previewStale
                    ? "Gespeicherte Vorschau (veraltet) anzeigen"
                    : "Gespeicherte kombinierte Vorschau anzeigen"
                }
              >
                <div className="flex items-center gap-1 truncate font-medium">
                  <Film className="h-3 w-3 shrink-0" aria-hidden />
                  Vorschau
                </div>
                <div className="text-muted">
                  {previewStale ? "veraltet" : "kombiniert"}
                </div>
              </button>
            )}
          </div>
          {typeof document !== "undefined" &&
            createPortal(
              <DragOverlay dropAnimation={clipDropAnimation}>
                {draggingPath
                  ? (() => {
                      const idx = videoList.findIndex(
                        (v) => v.path === draggingPath,
                      );
                      const v = idx >= 0 ? videoList[idx] : null;
                      if (!v) return null;
                      return (
                        <ClipChipOverlay
                          video={v}
                          active={einzelclipMode && idx === activeClip}
                          isWm={videoWmNeeded && watermarkClipIndex === idx}
                          cutMark={getCutMark(v.path)}
                        />
                      );
                    })()
                  : null}
              </DragOverlay>,
              document.body,
            )}
        </DndContext>
      )}

      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">Aktueller Clip</p>
          {current ? (
            <dl className="space-y-0.5 text-muted">
              <div>
                <dt className="inline text-foreground">Datei: </dt>
                <dd className="inline break-all">{current.filename}</dd>
              </div>
              <div>
                Auflösung: {current.width} × {current.height}
              </div>
              <div>Codec: {current.codec || "—"}</div>
              <div>Dauer: {formatDuration(current.duration_secs)}</div>
              <div>Größe: {formatBytes(current.size_bytes)}</div>
              {getCutMark(current.path) && (
                <div className="pt-1">
                  <span className="inline-block rounded bg-sky-600/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-300">
                    {getCutMark(current.path) === "trim" ? "Getrimmt" : "Geteilt"}
                  </span>
                </div>
              )}
              {videoWmNeeded && (
                <label className="mt-1.5 flex items-center gap-2 text-foreground">
                  <Checkbox
                    checked={watermarkClipIndex === activeClip}
                    disabled={busy}
                    onCheckedChange={() => toggleWatermarkClip(activeClip)}
                    aria-label="Wasserzeichen-Clip"
                  />
                  Wasserzeichen (Preview_Video)
                </label>
              )}
            </dl>
          ) : (
            <p className="text-muted">—</p>
          )}
          {current && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || qrBusy}
                onClick={() => void handleQrScan()}
              >
                <QrCode className="h-3.5 w-3.5" />
                QR scannen
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !onCutClip}
                onClick={() => onCutClip?.(current.path, activeClip)}
              >
                <Scissors className="h-3.5 w-3.5" />
                Schneiden
              </Button>
              {getCutMark(current.path) && onUndoClipCut && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onUndoClipCut(current.path)}
                  title="Diesen Schnitt rückgängig machen"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Schnitt rückgängig
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  onBeforeRemoveClip?.(current.path);
                  removeVideo(current.path);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Entfernen
              </Button>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">Gesamt / Preview</p>
          <dl className="space-y-0.5 text-muted">
            <div>Clips: {videoList.length}</div>
            <div>Gesamtdauer: {formatDuration(totalDuration)}</div>
            <div>Gesamtgröße: {formatBytes(totalSize)}</div>
            {preview && (
              <>
                <div>Strategie: {preview.strategy}</div>
                <div>Encoder: {preview.encoder}</div>
                <div>Intro: {preview.intro_included ? "ja" : "nein"}</div>
                {preview.reencode_reason ? (
                  <div>Neu-Kodierung: {preview.reencode_reason}</div>
                ) : (
                  <div>Neu-Kodierung: nein (Stream-Copy)</div>
                )}
              </>
            )}
          </dl>
        </div>
      </div>

      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, "Datei")}
        onCopied={() => showSuccess("Pfad in die Zwischenablage kopiert.", "Pfad")}
        actionsDisabled={busy || qrBusy}
        onScanQr={(path) => void handleQrScan(path)}
        onCut={
          onCutClip
            ? (path) => {
                const idx = videoList.findIndex((v) => v.path === path);
                onCutClip(path, idx >= 0 ? idx : 0);
              }
            : undefined
        }
        canUndoCut={Boolean(ctxMenu && getCutMark(ctxMenu.path))}
        onUndoCut={onUndoClipCut}
        onRemove={(path) => {
          onBeforeRemoveClip?.(path);
          removeVideo(path);
        }}
      />
    </div>
  );
}
