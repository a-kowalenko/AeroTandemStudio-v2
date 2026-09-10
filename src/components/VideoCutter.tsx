import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Crop,
  Image as ImageIcon,
  RotateCw,
  SplitSquareHorizontal,
} from "lucide-react";
import {
  VideoPlayer,
  formatPlayerTimeMs,
  type TrimHandle,
  type VideoPlayerHandle,
} from "./VideoPlayer";
import { MediaEditShell, type MediaEditModeOption } from "./MediaEditShell";
import { MediaEditControlsRow, MediaEditRotateBar, MediaEditToolReset } from "./MediaEditRotateBar";
import {
  VideoCutterPhotosControls,
  VideoCutterPhotosStrip,
  type FramePreviewItem,
} from "./VideoCutterPhotosPanel";
import { filmstripPrefetch, type FilmstripPrefetchPartial } from "../lib/filmstripPrefetch";
import { useUiStore } from "../store/uiStore";
import { useVideoStore } from "../store/videoStore";
import {
  keyframeAtOrAfter,
  keyframeAtOrBefore,
  nearestKeyframe,
} from "../lib/keyframes";
import {
  hasNetPreviewRotate,
} from "../lib/mediaPreviewRotate";

export type VideoCutterResult =
  | { action: "cancel" }
  | { action: "apply_trim"; startMs: number; endMs: number }
  | { action: "apply_split"; splitMs: number }
  | { action: "apply_rotate"; degrees: number }
  | {
      action: "apply_photos";
      paths: string[];
      importToSession: boolean;
      exportFolder: string | null;
    };

type VideoEditMode = "trim" | "rotate" | "split" | "photos";

type VideoCutterProps = {
  open: boolean;
  videoPath: string | null;
  durationSecsHint?: number;
  onClose: () => void;
  onComplete: (result: VideoCutterResult) => void;
};

const VIDEO_MODE_DEFS: { id: VideoEditMode; labelKey: string; icon: ReactNode }[] = [
  {
    id: "trim",
    labelKey: "video.edit.mode.trim",
    icon: <Crop className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "rotate",
    labelKey: "video.edit.mode.rotate",
    icon: <RotateCw className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "split",
    labelKey: "video.edit.mode.split",
    icon: <SplitSquareHorizontal className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "photos",
    labelKey: "video.edit.mode.photos",
    icon: <ImageIcon className="h-4 w-4" strokeWidth={2} />,
  },
];

/** Minimum length of each part after a split (both sides). */
const MIN_SPLIT_PART_MS = 10_000;

/**
 * Apple Photos–style video edit: one active mode, Fertig commits that mode.
 */
export function VideoCutter({
  open,
  videoPath,
  durationSecsHint,
  onClose,
  onComplete,
}: VideoCutterProps) {
  const { t } = useTranslation();
  const videoModes = useMemo<MediaEditModeOption<VideoEditMode>[]>(
    () =>
      VIDEO_MODE_DEFS.map(({ id, labelKey, icon }) => ({
        id,
        label: t(labelKey),
        icon,
      })),
    [t],
  );
  const playerRef = useRef<VideoPlayerHandle>(null);
  const committedRef = useRef(false);
  const showWarning = useUiStore((s) => s.showWarning);
  const mediaRevision = useVideoStore((s) =>
    videoPath ? s.getMediaRevision(videoPath) : 0,
  );
  const videoFps = useVideoStore((s) => {
    if (!videoPath) return 30;
    const item = s.videoList.find(
      (v) => v.path.replace(/\\/g, "/").toLowerCase() === videoPath.replace(/\\/g, "/").toLowerCase(),
    );
    return item?.fps && item.fps > 1 ? item.fps : 30;
  });
  const [mode, setMode] = useState<VideoEditMode>("trim");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [durationMs, setDurationMs] = useState(
    durationSecsHint && durationSecsHint > 0 ? durationSecsHint * 1000 : 0,
  );
  const [keyframesSecs, setKeyframesSecs] = useState<number[]>([]);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const [pendingRotateDeg, setPendingRotateDeg] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const rangeInitializedRef = useRef(false);
  const startMsRef = useRef(startMs);
  const endMsRef = useRef(endMs);
  startMsRef.current = startMs;
  endMsRef.current = endMs;

  const [photoItems, setPhotoItems] = useState<FramePreviewItem[]>([]);
  const [importToSession, setImportToSession] = useState(true);
  const [exportFolder, setExportFolder] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  const rotatePending = hasNetPreviewRotate(pendingRotateDeg);

  const trimDirty = useMemo(() => {
    const dur = durationMs;
    if (dur <= 0) return false;
    const s = startMs;
    const e = endMs > 0 ? endMs : dur;
    const nearFull = s <= 50 && Math.abs(e - dur) <= 50;
    return !nearFull && e - s >= 100;
  }, [startMs, endMs, durationMs]);

  const splitValid = useMemo(() => {
    const total = durationMs;
    if (total < MIN_SPLIT_PART_MS * 2) return false;
    let at = playheadMs;
    if (keyframesSecs.length > 0) {
      const nearest = nearestKeyframe(keyframesSecs, at / 1000);
      if (nearest != null) at = nearest * 1000;
    }
    return at >= MIN_SPLIT_PART_MS && at <= total - MIN_SPLIT_PART_MS;
  }, [playheadMs, durationMs, keyframesSecs]);

  const selectedPhotoPaths = useMemo(
    () => photoItems.filter((i) => i.selected).map((i) => i.path),
    [photoItems],
  );

  const photosDoneEnabled =
    selectedPhotoPaths.length >= 1 &&
    (importToSession || exportFolder != null) &&
    !extracting;

  const doneEnabled =
    mode === "trim"
      ? trimDirty
      : mode === "rotate"
        ? rotatePending
        : mode === "split"
          ? splitValid
          : photosDoneEnabled;

  const doneLabel =
    mode === "photos"
      ? selectedPhotoPaths.length > 0
        ? t("video.cutter.photos.applyCount", {
            count: selectedPhotoPaths.length,
          })
        : t("video.cutter.photos.apply")
      : undefined;

  useEffect(() => {
    if (!open) {
      rangeInitializedRef.current = false;
      setStartMs(0);
      setEndMs(0);
      setPendingRotateDeg(0);
      setPlayheadMs(0);
      setMode("trim");
      setPhotoItems([]);
      setImportToSession(true);
      setExportFolder(null);
      setExtracting(false);
      return;
    }
    committedRef.current = false;
    const hintMs =
      durationSecsHint && durationSecsHint > 0 ? durationSecsHint * 1000 : 0;
    if (hintMs > 0) {
      setDurationMs(hintMs);
      setStartMs(0);
      setEndMs(hintMs);
      rangeInitializedRef.current = true;
    }
    setPendingRotateDeg(0);
    setMode("trim");
    setPhotoItems([]);
    setImportToSession(true);
    setExportFolder(null);
    setExtracting(false);
  }, [open, videoPath, durationSecsHint]);

  useEffect(() => {
    if (!open) {
      setKeyframesSecs([]);
      setFilmstripFrames([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !videoPath) return;
    let cancelled = false;
    const durationHint =
      durationSecsHint && durationSecsHint > 0 ? durationSecsHint : null;

    const applyPartial = (partial: FilmstripPrefetchPartial) => {
      if (cancelled) return;
      if (partial.frames) setFilmstripFrames(partial.frames);
      if (partial.keyframesSecs) setKeyframesSecs(partial.keyframesSecs);
    };

    const cached = filmstripPrefetch.getPartial(videoPath, mediaRevision);
    if (cached?.frames) setFilmstripFrames(cached.frames);
    if (cached?.keyframesSecs) setKeyframesSecs(cached.keyframesSecs);
    if (filmstripPrefetch.isComplete(videoPath, mediaRevision)) {
      return () => {
        cancelled = true;
      };
    }

    void filmstripPrefetch
      .prefetch(videoPath, durationHint, mediaRevision, 100, applyPartial)
      .catch(() => {
        if (cancelled) return;
        const left = filmstripPrefetch.getPartial(videoPath, mediaRevision);
        if (!left?.frames) setFilmstripFrames([]);
        if (!left?.keyframesSecs) setKeyframesSecs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, videoPath, durationSecsHint, mediaRevision]);

  function finish(result: VideoCutterResult) {
    if (committedRef.current) return;
    committedRef.current = true;
    playerRef.current?.pause();
    onComplete(result);
    onClose();
  }

  function cancel() {
    if (extracting) return;
    if (committedRef.current) {
      onClose();
      return;
    }
    committedRef.current = true;
    playerRef.current?.pause();
    onComplete({ action: "cancel" });
    onClose();
  }

  function switchMode(next: VideoEditMode) {
    if (next === mode || extracting) return;
    // Leaving a mode drops its pending preview state (Photos discards uncommitted tool tweaks).
    if (mode === "rotate") setPendingRotateDeg(0);
    // Keep start/end across modes so photos interval can use the current trim range.
    if (mode === "photos" && next !== "photos") {
      setPhotoItems([]);
      setExportFolder(null);
      setImportToSession(true);
    }
    setMode(next);
  }

  function handleTrimChange(handle: TrimHandle, ms: number) {
    if (handle === "start") setStartMs(ms);
    else setEndMs(ms);
  }

  function handleTrimCommit(handle: TrimHandle, ms: number) {
    const dur = playerRef.current?.getDurationMs() || durationMs;
    let nextStart = startMsRef.current;
    let nextEnd = endMsRef.current > 0 ? endMsRef.current : dur;

    if (handle === "start") {
      let s = ms / 1000;
      if (keyframesSecs.length > 0) {
        const floored = keyframeAtOrBefore(keyframesSecs, s);
        s = floored ?? keyframeAtOrAfter(keyframesSecs, s) ?? s;
      }
      nextStart = s * 1000;
      if (nextStart >= nextEnd - 100) {
        const after = keyframeAtOrAfter(keyframesSecs, nextStart / 1000 + 1e-3);
        nextEnd = after != null ? after * 1000 : Math.min(dur, nextStart + 100);
      }
    } else {
      let e = ms / 1000;
      if (keyframesSecs.length > 0) {
        const ceiled = keyframeAtOrAfter(keyframesSecs, e);
        e = ceiled ?? keyframeAtOrBefore(keyframesSecs, e) ?? e;
      }
      nextEnd = e * 1000;
      if (nextEnd <= nextStart + 100) {
        const before = keyframeAtOrBefore(keyframesSecs, nextEnd / 1000 - 1e-3);
        nextStart = before != null ? before * 1000 : Math.max(0, nextEnd - 100);
      }
    }

    nextStart = Math.max(0, Math.min(nextStart, (dur || nextEnd) - 100));
    nextEnd = Math.min(dur || nextEnd, Math.max(nextEnd, nextStart + 100));

    setStartMs(nextStart);
    setEndMs(nextEnd);
    playerRef.current?.seekMs(handle === "start" ? nextStart : nextEnd);
  }

  /** Photos extract range: no keyframe snap; clears generated preview on commit. */
  function handlePhotoRangeCommit(handle: TrimHandle, ms: number) {
    const dur = playerRef.current?.getDurationMs() || durationMs;
    let nextStart = startMsRef.current;
    let nextEnd = endMsRef.current > 0 ? endMsRef.current : dur;

    if (handle === "start") {
      nextStart = ms;
      if (nextStart >= nextEnd - 100) {
        nextEnd = Math.min(dur, nextStart + 100);
      }
    } else {
      nextEnd = ms;
      if (nextEnd <= nextStart + 100) {
        nextStart = Math.max(0, nextEnd - 100);
      }
    }

    nextStart = Math.max(0, Math.min(nextStart, (dur || nextEnd) - 100));
    nextEnd = Math.min(dur || nextEnd, Math.max(nextEnd, nextStart + 100));

    setStartMs(nextStart);
    setEndMs(nextEnd);
    playerRef.current?.seekMs(handle === "start" ? nextStart : nextEnd);
    setPhotoItems([]);
  }

  function resetRange() {
    const dur = playerRef.current?.getDurationMs() || durationMs;
    setStartMs(0);
    setEndMs(dur);
    playerRef.current?.seekMs(0);
  }

  function resetPhotoRange() {
    resetRange();
    setPhotoItems([]);
  }

  function applyTrim() {
    const dur = playerRef.current?.getDurationMs() || durationMs;
    let s = startMs;
    let e = endMs > 0 ? endMs : dur;
    if (e < s) [s, e] = [e, s];

    const nearFull = s <= 50 && dur > 0 && Math.abs(e - dur) <= 50;
    if (nearFull || e - s < 100) {
      showWarning(
        nearFull
          ? t("video.cutter.warning.adjustHandles")
          : t("video.cutter.warning.rangeTooShort"),
        t("video.cutter.warning.noChangeTitle"),
      );
      return;
    }
    finish({ action: "apply_trim", startMs: s, endMs: e });
  }

  function applySplit() {
    let splitMs = playerRef.current?.getCurrentTimeMs() ?? playheadMs;
    const total = playerRef.current?.getDurationMs() || durationMs;
    if (keyframesSecs.length > 0) {
      const nearest = nearestKeyframe(keyframesSecs, splitMs / 1000);
      if (nearest != null) splitMs = nearest * 1000;
    }
    if (splitMs < MIN_SPLIT_PART_MS || splitMs > total - MIN_SPLIT_PART_MS) {
      showWarning(
        t("video.cutter.warning.invalidSplitBody"),
        t("video.cutter.warning.invalidSplitTitle"),
      );
      return;
    }
    finish({ action: "apply_split", splitMs });
  }

  function applyRotate() {
    const deg = ((pendingRotateDeg % 360) + 360) % 360;
    if (deg === 0) {
      showWarning(t("video.cutter.warning.noRotation"), t("video.cutter.warning.noChangeTitle"));
      return;
    }
    finish({ action: "apply_rotate", degrees: deg });
  }

  function applyPhotos() {
    if (!photosDoneEnabled) {
      showWarning(
        t("video.cutter.photos.needSelection"),
        t("video.cutter.warning.noChangeTitle"),
      );
      return;
    }
    finish({
      action: "apply_photos",
      paths: selectedPhotoPaths,
      importToSession,
      exportFolder,
    });
  }

  function handleDone() {
    if (mode === "trim") applyTrim();
    else if (mode === "rotate") applyRotate();
    else if (mode === "split") applySplit();
    else applyPhotos();
  }

  const keepRange =
    durationMs > 0
      ? {
          start: startMs / durationMs,
          end: (endMs > 0 ? endMs : durationMs) / durationMs,
        }
      : { start: 0, end: 1 };

  const keyframeMarks =
    durationMs > 0
      ? keyframesSecs
          .map((t) => (t * 1000) / durationMs)
          .filter((r) => r > 0.001 && r < 0.999)
      : [];

  const trimActive = mode === "trim";
  const rotateActive = mode === "rotate";
  const photosActive = mode === "photos";

  const controls =
    mode === "trim" ? (
      <MediaEditControlsRow
        reset={
          <MediaEditToolReset
            label={t("video.cutter.resetRange")}
            disabled={!trimDirty}
            onClick={resetRange}
          />
        }
      >
        <p className="font-mono text-[12px] tabular-nums text-muted">
          {formatPlayerTimeMs(startMs)} –{" "}
          {formatPlayerTimeMs(endMs > 0 ? endMs : durationMs)}
        </p>
      </MediaEditControlsRow>
    ) : mode === "rotate" ? (
      <MediaEditRotateBar
        degrees={pendingRotateDeg}
        onRotateCw={() => setPendingRotateDeg((d) => d + 90)}
        onRotateCcw={() => setPendingRotateDeg((d) => d - 90)}
        onReset={() => setPendingRotateDeg(0)}
      />
    ) : mode === "photos" && videoPath ? (
      <VideoCutterPhotosControls
        videoPath={videoPath}
        playheadMs={playheadMs}
        durationMs={durationMs}
        rangeStartMs={startMs}
        rangeEndMs={endMs > 0 ? endMs : durationMs}
        fpsHint={videoFps}
        items={photoItems}
        onItemsChange={setPhotoItems}
        importToSession={importToSession}
        onImportToSessionChange={setImportToSession}
        exportFolder={exportFolder}
        onExportFolderChange={setExportFolder}
        extracting={extracting}
        onExtractingChange={setExtracting}
        onError={(message, title) => showWarning(message, title)}
        seekMs={(ms) => playerRef.current?.seekMs(ms)}
        onResetRange={resetPhotoRange}
      />
    ) : (
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="font-mono text-[12px] tabular-nums text-muted">
          {t("video.cutter.playhead", { time: formatPlayerTimeMs(playheadMs) })}
        </p>
        <p className="text-[11px] text-muted/80">
          {t("video.cutter.splitHint")}
        </p>
      </div>
    );

  return (
    <MediaEditShell
      open={open}
      title={t("common.actions.edit")}
      description={videoPath}
      mode={mode}
      modes={videoModes}
      onModeChange={switchMode}
      onCancel={cancel}
      onDone={handleDone}
      doneEnabled={doneEnabled}
      doneLabel={doneLabel}
      controls={controls}
    >
      <div className="flex h-full min-h-0 w-full flex-col">
        <VideoPlayer
          ref={playerRef}
          fillAvailable
          className="min-h-0 flex-1"
          chrome={trimActive || photosActive ? "trim" : "playback"}
          // Rotate keeps the filmstrip (split-style) so stage height matches trim/split.
          emphasizePlayhead={mode === "split" || mode === "rotate"}
          rangeHandleTheme={photosActive ? "photos" : "trim"}
          snapSeekMs={
            mode === "split" && keyframesSecs.length > 0
              ? (ms) => {
                  const nearest = nearestKeyframe(keyframesSecs, ms / 1000);
                  return nearest != null ? nearest * 1000 : ms;
                }
              : undefined
          }
          srcPath={open ? videoPath : null}
          // Revision only — do not include durationMs (player reports duration after
          // boot and would remount → Kein Video / Thumbnail flicker).
          cacheKey={videoPath ? String(mediaRevision) : null}
          keepRange={trimActive || photosActive ? keepRange : undefined}
          keyframeMarks={keyframesSecs.length > 0 ? keyframeMarks : undefined}
          filmstripFrames={filmstripFrames}
          // Always pass a number (0 outside rotate) so absolute centering stays
          // mounted — toggling null↔layout + transition-transform slides the video.
          previewRotateDeg={pendingRotateDeg}
          previewRotateTransition={rotateActive}
          onTrimChange={
            trimActive || photosActive ? handleTrimChange : undefined
          }
          onTrimCommit={
            trimActive
              ? handleTrimCommit
              : photosActive
                ? handlePhotoRangeCommit
                : undefined
          }
          onTimeUpdate={(c, d) => {
            setPlayheadMs(c);
            if (d <= 0) return;
            setDurationMs(d);
            if (!rangeInitializedRef.current) {
              rangeInitializedRef.current = true;
              setStartMs(0);
              setEndMs(d);
            } else if (endMs <= 0) {
              setEndMs(d);
            }
          }}
        />
        {photosActive && photoItems.length > 0 ? (
          <div className="shrink-0 border-t border-white/10 bg-black/20 px-2 py-1.5">
            <VideoCutterPhotosStrip
              items={photoItems}
              onToggle={(id) =>
                setPhotoItems((prev) =>
                  prev.map((it) =>
                    it.id === id ? { ...it, selected: !it.selected } : it,
                  ),
                )
              }
              onRemove={(id) =>
                setPhotoItems((prev) => prev.filter((it) => it.id !== id))
              }
              compact
            />
          </div>
        ) : null}
      </div>
    </MediaEditShell>
  );
}
