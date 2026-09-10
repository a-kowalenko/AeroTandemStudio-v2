import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ImagePlus, StepBack, StepForward, X } from "lucide-react";
import { formatPlayerTimeMs } from "./VideoPlayer";
import { MediaEditToolReset } from "./MediaEditRotateBar";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { videoFileSrc } from "../lib/mediaUrl";
import { cn, isCancellationError } from "../lib/utils";
import {
  cancelEncode,
  extractVideoFrameAt,
  extractVideoFrames,
  previewFrameExtractTimes,
  type FrameExtractProgress,
} from "../lib/tauri";

export type FramePreviewItem = {
  id: string;
  path: string;
  timeSecs: number;
  selected: boolean;
  thumbUrl?: string;
};

type PhotoSubMode = "interval" | "single";

type ItemsUpdater =
  | FramePreviewItem[]
  | ((prev: FramePreviewItem[]) => FramePreviewItem[]);

type VideoCutterPhotosPanelProps = {
  videoPath: string;
  playheadMs: number;
  durationMs: number;
  /** Active trim range when set in trim mode; used as interval default. */
  rangeStartMs: number;
  rangeEndMs: number;
  fpsHint?: number;
  items: FramePreviewItem[];
  onItemsChange: (next: ItemsUpdater) => void;
  importToSession: boolean;
  onImportToSessionChange: (v: boolean) => void;
  exportFolder: string | null;
  onExportFolderChange: (v: string | null) => void;
  extracting: boolean;
  onExtractingChange: (v: boolean) => void;
  onError: (message: string, title?: string) => void;
  seekMs: (ms: number) => void;
  onResetRange: () => void;
};

function approxCount(startMs: number, endMs: number, intervalSec: number): number {
  if (!(intervalSec > 0) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 1000 / intervalSec) + 1;
}

function frameSnapToleranceSecs(fps: number): number {
  const f = fps > 1 && Number.isFinite(fps) ? fps : 30;
  return 1 / f;
}

const THUMB_URL_CONCURRENCY = 8;

/** Cap visible label length (e.g. keep Export:… as short as „Zusätzlich exportieren…“). */
function clipLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Resolve media URLs in parallel; patch items as each URL arrives. */
async function hydrateThumbUrls(
  targets: FramePreviewItem[],
  onItemsChange: (next: ItemsUpdater) => void,
) {
  const pending = targets.filter((it) => !it.thumbUrl && it.path);
  if (pending.length === 0) return;

  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      if (!item) break;
      try {
        const url = await videoFileSrc(item.path);
        onItemsChange((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, thumbUrl: url } : p)),
        );
      } catch {
        /* keep placeholder */
      }
    }
  }

  const workers = Math.min(THUMB_URL_CONCURRENCY, pending.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

export function VideoCutterPhotosControls({
  videoPath,
  playheadMs,
  durationMs,
  rangeStartMs,
  rangeEndMs,
  fpsHint = 30,
  items,
  onItemsChange,
  importToSession,
  onImportToSessionChange,
  exportFolder,
  onExportFolderChange,
  extracting,
  onExtractingChange,
  onError,
  seekMs,
  onResetRange,
}: VideoCutterPhotosPanelProps) {
  const { t } = useTranslation();
  const [subMode, setSubMode] = useState<PhotoSubMode>("interval");
  const [intervalSec, setIntervalSec] = useState(0.5);
  const [progress, setProgress] = useState<FrameExtractProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const idSeq = useRef(1);

  const rangeStart = Math.max(0, rangeStartMs);
  const rangeEnd =
    rangeEndMs > rangeStart ? rangeEndMs : durationMs > 0 ? durationMs : rangeStart;
  const estimate = useMemo(
    () => approxCount(rangeStart, rangeEnd, intervalSec),
    [rangeStart, rangeEnd, intervalSec],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<FrameExtractProgress>("frame-extract-progress", (ev) => {
      setProgress(ev.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!extracting) setCancelling(false);
  }, [extracting]);

  async function runIntervalGenerate() {
    if (!videoPath || extracting) return;
    onExtractingChange(true);
    setCancelling(false);
    setProgress({ done: 0, total: estimate || 1, time_secs: 0 });
    try {
      const times = await previewFrameExtractTimes(
        rangeStart / 1000,
        rangeEnd / 1000,
        intervalSec,
      );
      if (times.length === 0) {
        onError(t("video.cutter.photos.noFrames"), t("video.cutter.photos.title"));
        return;
      }
      const frames = await extractVideoFrames(videoPath, times);
      const mapped: FramePreviewItem[] = frames.map((f) => ({
        id: `f-${idSeq.current++}`,
        path: f.path,
        timeSecs: f.time_secs,
        selected: true,
      }));
      // Show strip immediately; hydrate HTTP URLs in the background.
      onItemsChange(mapped);
      onExtractingChange(false);
      setProgress(null);
      setCancelling(false);
      void hydrateThumbUrls(mapped, onItemsChange);
      return;
    } catch (e) {
      if (!isCancellationError(e)) {
        onError(
          e instanceof Error ? e.message : String(e),
          t("video.cutter.photos.extractFailed"),
        );
      }
    } finally {
      onExtractingChange(false);
      setProgress(null);
      setCancelling(false);
    }
  }

  async function addFrameAtPlayhead() {
    if (!videoPath || extracting) return;
    const tSecs = playheadMs / 1000;
    const tol = frameSnapToleranceSecs(fpsHint);
    if (items.some((it) => Math.abs(it.timeSecs - tSecs) <= tol)) {
      return;
    }
    onExtractingChange(true);
    setCancelling(false);
    setProgress({ done: 0, total: 1, time_secs: tSecs });
    try {
      const frame = await extractVideoFrameAt(videoPath, tSecs);
      const item: FramePreviewItem = {
        id: `f-${idSeq.current++}`,
        path: frame.path,
        timeSecs: frame.time_secs,
        selected: true,
      };
      onItemsChange((prev) => [...prev, item]);
      onExtractingChange(false);
      setProgress(null);
      setCancelling(false);
      void hydrateThumbUrls([item], onItemsChange);
      return;
    } catch (e) {
      if (!isCancellationError(e)) {
        onError(
          e instanceof Error ? e.message : String(e),
          t("video.cutter.photos.extractFailed"),
        );
      }
    } finally {
      onExtractingChange(false);
      setProgress(null);
      setCancelling(false);
    }
  }

  async function pickExportFolder() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: exportFolder || undefined,
      title: t("video.cutter.photos.pickExportFolder"),
    });
    if (typeof selected === "string") {
      onExportFolderChange(selected);
    }
  }

  function nudge(deltaFrames: number) {
    const fps = fpsHint > 1 ? fpsHint : 30;
    const next = Math.max(0, Math.min(durationMs, playheadMs + (deltaFrames * 1000) / fps));
    seekMs(next);
  }

  async function cancelExtract() {
    if (cancelling) return;
    setCancelling(true);
    await cancelEncode();
  }

  const folderName = exportFolder
    ? exportFolder.replace(/\\/g, "/").split("/").pop() || exportFolder
    : null;

  const alsoExportLabel = t("video.cutter.photos.alsoExport");
  const exportLabel = folderName
    ? clipLabel(
        t("video.cutter.photos.exportTo", { folder: folderName }),
        alsoExportLabel.length - 3, // -3 um die ... auch abzuziehen
      )
    : alsoExportLabel;

  const destinations = (
    <div className="flex shrink-0 flex-col justify-center gap-1 text-[12px]">
      <label className="inline-flex min-w-0 items-center gap-1.5 text-muted">
        <Switch
          checked={importToSession}
          disabled={extracting}
          onCheckedChange={onImportToSessionChange}
          aria-label={t("video.cutter.photos.importToSession")}
        />
        <span className="whitespace-nowrap">
          {t("video.cutter.photos.importToSession")}
        </span>
      </label>
      <label className="inline-flex min-w-0 items-center gap-1.5 text-muted">
        <Switch
          checked={exportFolder != null}
          disabled={extracting}
          onCheckedChange={(on) => {
            if (on) void pickExportFolder();
            else onExportFolderChange(null);
          }}
          aria-label={
            folderName
              ? t("video.cutter.photos.pickExportFolder")
              : alsoExportLabel
          }
        />
        <span
          className={cn(
            "whitespace-nowrap",
            folderName && "cursor-pointer text-accent hover:underline",
          )}
          title={exportFolder ?? undefined}
          onClick={(e) => {
            if (!folderName || extracting) return;
            e.preventDefault();
            e.stopPropagation();
            void pickExportFolder();
          }}
        >
          {exportLabel}
        </span>
      </label>
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex w-full items-center gap-2 sm:gap-3">
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-lg bg-black/5 p-0.5 dark:bg-white/10"
          role="tablist"
          aria-label={t("video.cutter.photos.title")}
        >
          {(
            [
              ["interval", t("video.cutter.photos.sub.interval")],
              ["single", t("video.cutter.photos.sub.single")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              disabled={extracting}
              aria-selected={subMode === id}
              onClick={() => setSubMode(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition",
                subMode === id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Mode actions — stacked so Interval ↔ Single does not reflow */}
        <div className="grid min-w-0 flex-1 grid-cols-1 justify-items-center">
          <div
            className={cn(
              "col-start-1 row-start-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]",
              subMode !== "interval" && "invisible pointer-events-none",
            )}
            aria-hidden={subMode !== "interval"}
          >
            <label className="flex items-center gap-1.5 text-muted">
              <span className="hidden lg:inline">
                {t("video.cutter.photos.interval")}
              </span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={intervalSec}
                disabled={extracting || subMode !== "interval"}
                tabIndex={subMode === "interval" ? 0 : -1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) setIntervalSec(v);
                }}
                className="w-14 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[12px] tabular-nums"
              />
              <span>s</span>
            </label>
            <span className="min-w-[4.5rem] text-center text-muted/80 tabular-nums">
              {t("video.cutter.photos.estimate", { count: estimate })}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={extracting || estimate < 1 || subMode !== "interval"}
              tabIndex={subMode === "interval" ? 0 : -1}
              onClick={() => void runIntervalGenerate()}
            >
              {t("video.cutter.photos.generate")}
            </Button>
          </div>

          <div
            className={cn(
              "col-start-1 row-start-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]",
              subMode !== "single" && "invisible pointer-events-none",
            )}
            aria-hidden={subMode !== "single"}
          >
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8"
              disabled={extracting || subMode !== "single"}
              tabIndex={subMode === "single" ? 0 : -1}
              onClick={() => nudge(-1)}
              title={t("video.cutter.photos.nudgeBack")}
              aria-label={t("video.cutter.photos.nudgeBack")}
            >
              <StepBack className="h-4 w-4" strokeWidth={2} />
            </Button>
            <span className="min-w-[4.25rem] text-center font-mono tabular-nums text-muted">
              {formatPlayerTimeMs(playheadMs)}
            </span>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8"
              disabled={extracting || subMode !== "single"}
              tabIndex={subMode === "single" ? 0 : -1}
              onClick={() => nudge(1)}
              title={t("video.cutter.photos.nudgeFwd")}
              aria-label={t("video.cutter.photos.nudgeFwd")}
            >
              <StepForward className="h-4 w-4" strokeWidth={2} />
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={extracting || subMode !== "single"}
              tabIndex={subMode === "single" ? 0 : -1}
              onClick={() => void addFrameAtPlayhead()}
            >
              <ImagePlus className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden lg:inline">
                {t("video.cutter.photos.addFrame")}
              </span>
            </Button>
          </div>
        </div>

        {destinations}

        <MediaEditToolReset
          label={t("video.cutter.resetRange")}
          disabled={
            extracting ||
            (rangeStart <= 0 && rangeEnd >= Math.max(0, durationMs - 1))
          }
          onClick={onResetRange}
          className="shrink-0"
        />
      </div>

      {extracting && progress ? (
        <div className="flex shrink-0 items-center justify-center gap-2 text-[11px] text-muted">
          <span>
            {t("video.cutter.photos.progress", {
              done: progress.done,
              total: progress.total,
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancelling}
            onClick={() => void cancelExtract()}
          >
            {cancelling
              ? t("common.actions.cancelling")
              : t("common.actions.cancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type FrameStripProps = {
  items: FramePreviewItem[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  /** Smaller thumbs for the edit-shell controls band. */
  compact?: boolean;
};

/** Horizontal virtualized-ish strip: only mounts ~visible thumbs + buffer. */
export function VideoCutterPhotosStrip({
  items,
  onToggle,
  onRemove,
  compact = false,
}: FrameStripProps) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(0);
  const THUMB = compact ? 48 : 72;
  const GAP = compact ? 6 : 8;
  const stride = THUMB + GAP;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, THUMB]);

  const start = Math.max(0, Math.floor(scrollLeft / stride) - 2);
  const visible = Math.max(1, Math.ceil((viewW || 400) / stride) + 4);
  const end = Math.min(items.length, start + visible);
  const padLeft = start * stride;
  const padRight = Math.max(0, (items.length - end) * stride);

  if (items.length === 0) return null;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col",
        compact ? "gap-0.5 pt-0.5" : "min-h-0 flex-1 px-2 py-2",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between text-[11px] text-muted",
          compact ? "px-0.5" : "mb-1 px-1",
        )}
      >
        <span>
          {t("video.cutter.photos.selectedCount", {
            selected: items.filter((i) => i.selected).length,
            total: items.length,
          })}
        </span>
      </div>
      <div
        ref={scrollerRef}
        className="ats-photos-strip-scroll flex min-w-0 overflow-x-auto pb-0.5"
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div aria-hidden className="shrink-0" style={{ width: padLeft }} />
        {items.slice(start, end).map((item) => (
          <div
            key={item.id}
            className="relative shrink-0"
            style={{ width: THUMB, marginRight: GAP }}
          >
            <button
              type="button"
              onClick={() => onToggle(item.id)}
              className={cn(
                "block overflow-hidden rounded-md border-2 bg-black/40",
                compact ? "h-12 w-12" : "h-[72px] w-[72px]",
                item.selected ? "border-primary" : "border-transparent opacity-50",
              )}
              title={formatPlayerTimeMs(item.timeSecs * 1000)}
            >
              {item.thumbUrl ? (
                <img
                  src={item.thumbUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="h-full w-full animate-pulse bg-neutral-700/80" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className={cn(
                "absolute flex items-center justify-center rounded-full bg-black/80 text-white hover:bg-black",
                compact
                  ? "-right-0.5 -top-0.5 h-4 w-4"
                  : "-right-1 -top-1 h-5 w-5",
              )}
              aria-label={t("common.actions.remove")}
            >
              <X
                className={compact ? "h-2.5 w-2.5" : "h-3 w-3"}
                strokeWidth={2.5}
              />
            </button>
          </div>
        ))}
        <div aria-hidden className="shrink-0" style={{ width: padRight }} />
      </div>
    </div>
  );
}
