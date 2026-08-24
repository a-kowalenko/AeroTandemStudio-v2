import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
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
import {
  Film,
  Loader2,
  Pencil,
  Play,
  QrCode,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { VideoPlayer, type VideoPlayerHandle } from "./VideoPlayer";
import { filmstripPrefetch } from "../lib/filmstripPrefetch";
import {
  previewThumbnailQueue,
  THUMB_PRIORITY,
} from "../lib/thumbnailQueue";
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
import { QrScanRowBar, QrScanTileBadge } from "../hooks/useQrScanProgress";
import {
  useVideoThumbnailSrc,
  videoPosterBustKey,
} from "../hooks/useVideoThumbnailSrc";
import { maybeRemoveQrVideo } from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import { requestKundenIdFocus } from "../lib/kundenIdFocus";
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

const CLIP_POSTER_W = "w-[9.5rem]";

type ClipChipProps = {
  video: VideoMetadata;
  index: number;
  active: boolean;
  isWm: boolean;
  cutMark: "trim" | "split" | "rotate" | null;
  revision: number;
  scrollRootRef: RefObject<HTMLElement | null>;
  onSelect: (index: number) => void;
  onContextMenu: (e: MouseEvent, path: string) => void;
};

function rectNearlyIntersects(
  el: DOMRect,
  root: DOMRect,
  marginX: number,
  marginY: number,
): boolean {
  return (
    el.right >= root.left - marginX &&
    el.left <= root.right + marginX &&
    el.bottom >= root.top - marginY &&
    el.top <= root.bottom + marginY
  );
}

function ClipPosterFace({
  video,
  isWm,
  cutMark,
  revision,
  loadThumb,
  overlay,
}: {
  video: VideoMetadata;
  isWm: boolean;
  cutMark: "trim" | "split" | "rotate" | null;
  revision: number;
  loadThumb: boolean;
  overlay?: boolean;
}) {
  const { t } = useTranslation();
  const bustKey = videoPosterBustKey(
    video.size_bytes,
    video.duration_secs,
    revision,
  );
  // Stable priority — active boost is handled by VideoPreview / queue.boost.
  // Changing priority here would remount the request and race the player.
  const thumbSrc = useVideoThumbnailSrc(
    video.path,
    bustKey,
    THUMB_PRIORITY.warm,
    {
      enabled: loadThumb && !overlay,
    },
  );
  const overlaySrc = overlay
    ? previewThumbnailQueue.getCached(video.path, bustKey)
    : null;
  const src = overlay ? overlaySrc : thumbSrc;

  return (
    <>
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted/50">
        {src ? (
          <img
            src={src}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            aria-hidden
          >
            {loadThumb && !overlay ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/80" />
            ) : (
              <Film className="h-5 w-5 text-muted-foreground/50" />
            )}
          </div>
        )}
        <span className="pointer-events-none absolute right-1 bottom-1 z-[2] rounded bg-black/75 px-1 py-px text-[10px] font-semibold tabular-nums leading-none text-white shadow-sm">
          {formatDuration(video.duration_secs)}
        </span>
        <div className="pointer-events-none absolute top-1 left-1 z-[1] flex flex-col items-start gap-0.5">
          {!overlay && <QrScanTileBadge path={video.path} compact />}
          {cutMark && (
            <span
              className="rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
              aria-label={
                cutMark === "trim"
                  ? t("video.preview.cutTrim")
                  : cutMark === "rotate"
                    ? t("video.preview.cutRotate")
                    : t("video.preview.cutSplit")
              }
            >
              {cutMark === "trim"
                ? t("video.preview.cutTrimShort")
                : cutMark === "rotate"
                  ? t("video.preview.cutRotateShort")
                  : t("video.preview.cutSplitShort")}
            </span>
          )}
        </div>
        {isWm && (
          <span
            className="absolute top-1 right-1 z-[1] rounded bg-amber-500 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
            aria-label={t("common.actions.watermark")}
          >
            {t("common.actions.watermarkShort")}
          </span>
        )}
        {!overlay && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] px-0.5 pb-0.5">
            <QrScanRowBar path={video.path} />
          </div>
        )}
      </div>
      <div className="mt-1 truncate px-0.5 text-[11px] font-medium leading-tight">
        {video.filename}
      </div>
      <div className="truncate px-0.5 text-[10px] text-muted">
        {video.width}×{video.height}
      </div>
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
  scrollRootRef,
  onSelect,
  onContextMenu,
}: ClipChipProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [inView, setInView] = useState(active);
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

  useEffect(() => {
    if (active) {
      setInView(true);
      return;
    }
    const el = buttonRef.current;
    if (!el) return;

    let io: IntersectionObserver | null = null;
    let cancelled = false;
    const marginX = 120;
    const marginY = 40;

    const applyGeometry = (root: Element | null) => {
      const er = el.getBoundingClientRect();
      if (root) {
        setInView(
          rectNearlyIntersects(er, root.getBoundingClientRect(), marginX, marginY),
        );
        return;
      }
      const vr = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      } as DOMRect;
      setInView(rectNearlyIntersects(er, vr, marginX, marginY));
    };

    const connect = () => {
      if (cancelled) return;
      const root = scrollRootRef.current;
      io?.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            setInView(entry.isIntersecting);
          }
        },
        {
          root: root ?? null,
          rootMargin: `${marginY}px ${marginX}px`,
          threshold: 0.01,
        },
      );
      io.observe(el);
      const records = io.takeRecords();
      if (records.length > 0) {
        setInView(records.some((e) => e.isIntersecting));
      } else {
        applyGeometry(root);
      }
    };

    connect();
    const raf = window.requestAnimationFrame(connect);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [scrollRootRef, video.path, active]);

  const setRefs = (node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    setNodeRef(node);
  };

  // With DragOverlay: keep the source as a stationary ghost (no pointer delta).
  // Sibling chips still receive layout transforms for the snappy shuffle.
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    transition: transition ?? undefined,
  };

  const loadThumb = active || inView;

  return (
    <button
      ref={setRefs}
      type="button"
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(index)}
      onContextMenu={(e) => onContextMenu(e, video.path)}
      aria-busy={loadThumb && !previewThumbnailQueue.getCached(
        video.path,
        videoPosterBustKey(video.size_bytes, video.duration_secs, revision),
      ) ? true : undefined}
      className={cn(
        "relative shrink-0 touch-none rounded-lg border p-1 text-left",
        CLIP_POSTER_W,
        "cursor-grab active:cursor-grabbing",
        "will-change-transform",
        active
          ? "border-primary bg-primary-soft ring-2 ring-primary/25"
          : "border-border/70 bg-card/70 hover:border-primary/40",
        isDragging && "opacity-35 shadow-none",
      )}
      title={isWm ? `${video.path} (Wasserzeichen)` : video.path}
      data-revision={revision}
    >
      <ClipPosterFace
        video={video}
        isWm={isWm}
        cutMark={cutMark}
        revision={revision}
        loadThumb={loadThumb}
      />
    </button>
  );
}

function ClipChipOverlay({
  video,
  active,
  isWm,
  cutMark,
  revision,
}: {
  video: VideoMetadata;
  active: boolean;
  isWm: boolean;
  cutMark: "trim" | "split" | "rotate" | null;
  revision: number;
}) {
  return (
    <div
      className={cn(
        "relative rounded-lg border p-1 text-left",
        CLIP_POSTER_W,
        "shadow-xl ring-2 ring-primary/35",
        "cursor-grabbing",
        active
          ? "border-primary bg-primary-soft"
          : "border-border bg-card",
      )}
    >
      <ClipPosterFace
        video={video}
        isWm={isWm}
        cutMark={cutMark}
        revision={revision}
        loadThumb={false}
        overlay
      />
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
  /** Status line for the floating progress panel. */
  onStatus?: (message: string) => void;
  /** External progress when App already listens — if omitted, listens locally */
  percent?: number;
  status?: string;
  taskProgress?: TaskProgressState[];
  onProgressReset?: () => void;
  /** Called when preview encode finishes successfully. */
  onProgressComplete?: (status: string) => void;
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
  onStatus,
  onProgressReset,
  onProgressComplete,
  onCutClip,
  onUndoClipCut,
  onUndoAllCuts,
  canUndoCuts = false,
  onBeforeRemoveClip,
  formReady = true,
  formHints = [],
  playbackSuspended = false,
}: VideoPreviewProps) {
  const { t } = useTranslation();
  const videoList = useVideoStore((s) => s.videoList);
  const videoImporting = useVideoStore((s) => s.importing);
  const removeVideo = useVideoStore((s) => s.removeVideo);
  const reorderVideos = useVideoStore((s) => s.reorderVideos);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const toggleWatermarkClip = useVideoStore((s) => s.toggleWatermarkClip);
  const getCutMark = useVideoStore((s) => s.getCutMark);
  const getMediaRevision = useVideoStore((s) => s.getMediaRevision);
  const cutMarks = useVideoStore((s) => s.cutMarks);
  const kunde = useKundeStore((s) => s.kunde);
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

  // Prioritize poster for the clip the user is viewing (OPT-10).
  useEffect(() => {
    const clip = videoList[activeClip];
    if (!clip) return;
    previewThumbnailQueue.boost(
      clip.path,
      videoPosterBustKey(
        clip.size_bytes,
        clip.duration_secs,
        getMediaRevision(clip.path),
      ),
    );
  }, [activeClip, videoList, getMediaRevision]);

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
  const workflowBusy = busy || qrBusy || videoImporting;

  // Pause filmstrip prefetch during import/encode/QR (OPT-7).
  useEffect(() => {
    filmstripPrefetch.setPaused(workflowBusy);
  }, [workflowBusy]);

  // Warm filmstrip + keyframes for active clip (and next) while idle (OPT-7).
  useEffect(() => {
    if (workflowBusy) return;
    const active = videoList[activeClip];
    if (!active) return;
    const next = videoList[activeClip + 1];
    const clips = [
      {
        path: active.path,
        durationSecs: active.duration_secs > 0 ? active.duration_secs : null,
        revision: getMediaRevision(active.path),
      },
    ];
    if (next) {
      clips.push({
        path: next.path,
        durationSecs: next.duration_secs > 0 ? next.duration_secs : null,
        revision: getMediaRevision(next.path),
      });
    }
    filmstripPrefetch.schedule(clips);
  }, [activeClip, videoList, workflowBusy, getMediaRevision]);

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
    onProgressReset?.();
  }

  async function handleGenerate() {
    if (videoList.length === 0) {
      showError(t("media.drop.noVideos"));
      return;
    }
    const paths = videoList.map((v) => v.path);
    try {
      const form = await validateKunde(kunde, paths, oldschoolMode);
      if (!form.valid) {
        showWarning(form.errors.join("\n"), t("create.validation.validation"));
        return;
      }
    } catch (e) {
      showError(String(e), t("create.validation.validation"));
      return;
    }
    if (!formReady) {
      const hint =
        formHints.filter((h) => !h.includes("Speicherort")).join("\n") ||
        t("video.preview.formIncomplete");
      showWarning(hint, t("create.validation.validation"));
      return;
    }

    setBusy(true);
    resetLocalProgress();
    onStatus?.(t("video.preview.generating"));
    try {
      const result = await generatePreview(paths, kunde);
      setPreview(result);
      setPreviewCache(result, videoList, kunde, encodingSig);
      setPlayerMode("combined");
      onProgressComplete?.(t("video.preview.ready"));
      const strategy =
        result.strategy === "stream_copy_only"
          ? t("video.preview.strategyStreamCopy")
          : result.strategy === "per_clip"
            ? t("video.preview.strategyPerClip")
            : result.strategy === "combined"
              ? t("video.preview.strategyCombined")
              : result.strategy;
      const reasonSuffix = result.reencode_reason
        ? t("video.preview.reencodeSuffix", { reason: result.reencode_reason })
        : "";
      showSuccess(
        result.intro_included
          ? t("video.preview.combinedCreatedWithIntro", { strategy, suffix: reasonSuffix })
          : t("video.preview.combinedCreated", { strategy, suffix: reasonSuffix }),
        t("video.preview.toastTitle"),
        { autoCloseSecs: 5 },
      );
    } catch (e) {
      if (isCancellationError(e)) {
        onStatus?.(t("progress.default.cancelled"));
        showWarning(t("video.preview.cancelled"));
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
        showWarning(result.message, t("app.qr.label"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path ?? clip.path,
          preview: result.preview,
          runCleanup: () =>
            maybeRemoveQrVideo(result.source_path ?? clip.path, {
              onBeforeRemove: (p) => onBeforeRemoveClip?.(p),
            }),
        });
      } else {
        showWarning(result.message || t("media.list.noQrClip"), t("app.qr.label"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("app.qr.label"));
      requestKundenIdFocus();
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
          {t("video.preview.title")}
        </h3>
        <div className="flex flex-wrap gap-2">
          {canUndoCuts && onUndoAllCuts && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onUndoAllCuts()}
              disabled={busy}
              title={t("video.preview.undoAllEditsTitle")}
            >
              <RotateCcw className="h-4 w-4" />
              {t("video.preview.undoAllEditsBtn")}
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
                      t("video.preview.formIncompleteShort")
                }
              >
                <Play className="h-4 w-4" />
                {t("video.preview.generatePreview")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={showingCombined ? "default" : "secondary"}
                  onClick={showCombinedPreview}
                  disabled={busy}
                  title={t("video.preview.showExistingTitle")}
                >
                  <Play className="h-4 w-4" />
                  {t("video.preview.showPreview")}
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
                        ? t("video.preview.staleRegenerateTitle")
                        : t("video.preview.regenerateTitle")
                      : formHints.filter((h) => !h.includes("Speicherort"))[0] ||
                        t("video.preview.formIncompleteShort")
                  }
                >
                  <RefreshCw className="h-4 w-4" />
                  {previewStale ? t("video.preview.regenerateBtn") : t("video.preview.regenerateNew")}
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
          {t("video.preview.stale")}
        </div>
      )}

      {showingCombined && preview?.preview_path ? (
        <div className={cn("relative", previewStale && "opacity-80")}>
          <VideoPlayer
            ref={combinedPlayerRef}
            chrome="playback"
            srcPath={preview.preview_path}
            disabled={busy}
          />
          {previewStale && (
            <span className="pointer-events-none absolute top-2 right-2 rounded bg-amber-600/90 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
              {t("video.preview.staleBadge")}
            </span>
          )}
        </div>
      ) : current ? (
        <VideoPlayer
          ref={clipPlayerRef}
          chrome="playback"
          srcPath={current.path}
          cacheKey={videoPosterBustKey(
            current.size_bytes,
            current.duration_secs,
            getMediaRevision(current.path),
          )}
          disabled={busy}
          autoPlay={playOnLoad && !playbackSuspended}
          onEnded={handleClipEnded}
        />
      ) : (
        <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-[var(--ats-preview-stage)] text-sm text-white/75 ring-1 ring-border">
          <Film className="h-8 w-8 opacity-50" aria-hidden />
          <p>{t("video.preview.empty")}</p>
        </div>
      )}

      {einzelclipMode && current && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {hasPreviewFile
              ? t("video.preview.singleClipWithPreview")
              : t("video.preview.singleClipWithoutPreview")}
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
              {t("video.preview.autoNextClip")}
            </Label>
          </div>
        </div>
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
                    scrollRootRef={clipStripRef}
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
                  "relative shrink-0 rounded-lg border p-1 text-left transition",
                  CLIP_POSTER_W,
                  showingCombined
                    ? "border-primary bg-primary-soft ring-2 ring-primary/25"
                    : "border-border/70 bg-card/70 hover:border-primary/40",
                )}
                  title={
                    previewStale
                      ? t("video.preview.showSavedStale")
                      : t("video.preview.showSaved")
                  }
              >
                <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted/50">
                  <Film className="h-6 w-6 text-muted-foreground/70" aria-hidden />
                  {previewStale && (
                    <span className="absolute top-1 right-1 rounded bg-amber-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm">
                      {t("video.preview.staleBadgeShort")}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate px-0.5 text-[11px] font-medium leading-tight">
                  {t("video.preview.combinedLabel")}
                </div>
                <div className="truncate px-0.5 text-[10px] text-muted">
                  {previewStale ? t("video.preview.combinedStale") : t("video.preview.combinedFresh")}
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
                          revision={getMediaRevision(v.path)}
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
          <p className="mb-1 font-semibold">{t("video.preview.currentClip")}</p>
          {current ? (
            <dl className="space-y-0.5 text-muted">
              <div>
                <dt className="inline text-foreground">{t("video.preview.fileLabel")} </dt>
                <dd className="inline break-all">{current.filename}</dd>
              </div>
              <div>
                {t("video.preview.resolutionLabel")} {current.width} × {current.height}
              </div>
              <div>{t("video.preview.codecLabel")} {current.codec || "—"}</div>
              <div>{t("video.preview.durationLabel")} {formatDuration(current.duration_secs)}</div>
              <div>{t("video.preview.sizeLabel")} {formatBytes(current.size_bytes)}</div>
              {getCutMark(current.path) && (
                <div className="pt-1">
                  <span className="inline-block rounded bg-sky-600/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-300">
                    {getCutMark(current.path) === "trim"
                      ? t("video.preview.cutTrim")
                      : getCutMark(current.path) === "rotate"
                        ? t("video.preview.cutRotate")
                        : t("video.preview.cutSplit")}
                  </span>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-muted">—</p>
          )}
          {current && videoWmNeeded && (
            <button
              type="button"
              disabled={busy}
              aria-pressed={watermarkClipIndex === activeClip}
              aria-label={t("video.preview.watermarkStampAria")}
              onClick={() => toggleWatermarkClip(activeClip)}
              className={cn(
                "mt-2 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                watermarkClipIndex === activeClip
                  ? "border-amber-500/50 bg-amber-500/15 ring-1 ring-inset ring-amber-500/30"
                  : "border-border/60 bg-background/40 hover:border-border hover:bg-background/70",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">
                  {t("video.preview.previewExportTitle")}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                  {t("video.preview.previewExportHint")}
                </span>
              </span>
              <Checkbox
                checked={watermarkClipIndex === activeClip}
                tabIndex={-1}
                aria-hidden
                className={cn(
                  "pointer-events-none h-6 w-6 [&_svg]:h-4 [&_svg]:w-4",
                  watermarkClipIndex === activeClip &&
                    "border-amber-500 data-[state=checked]:border-amber-500 data-[state=checked]:bg-amber-500",
                )}
              />
            </button>
          )}
          {current && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !onCutClip}
                onClick={() => onCutClip?.(current.path, activeClip)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t("common.actions.edit")}
              </Button>
              {getCutMark(current.path) && onUndoClipCut && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onUndoClipCut(current.path)}
                  title={t("video.preview.undoThisEditTitle")}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("common.actions.undo")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || qrBusy}
                onClick={() => void handleQrScan()}
              >
                <QrCode className="h-3.5 w-3.5" />
                {t("media.list.scanQr")}
              </Button>
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
                {t("common.actions.remove")}
              </Button>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">{t("video.preview.totalPreview")}</p>
          <dl className="space-y-0.5 text-muted">
            <div>{t("video.preview.clipsCount")} {videoList.length}</div>
            <div>{t("video.preview.totalDuration")} {formatDuration(totalDuration)}</div>
            <div>{t("video.preview.totalSize")} {formatBytes(totalSize)}</div>
            {preview && (
              <>
                <div>{t("video.preview.strategyLabel")} {preview.strategy}</div>
                <div>{t("video.preview.encoderLabel")} {preview.encoder}</div>
                <div>
                  {t("video.preview.introLabel")}{" "}
                  {preview.intro_included ? t("common.labels.yes") : t("common.labels.no")}
                </div>
                {preview.reencode_reason ? (
                  <div>
                    {t("video.preview.previewReencode", {
                      reason: preview.reencode_reason,
                    })}
                  </div>
                ) : (
                  <div>{t("video.preview.previewStreamCopy")}</div>
                )}
              </>
            )}
          </dl>
        </div>
      </div>

      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, t("media.list.fileTitle"))}
        onCopied={() => showSuccess(t("media.list.pathCopied"), t("media.list.pathTitle"))}
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
