import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Crop,
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
import { MediaEditRotateBar } from "./MediaEditRotateBar";
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
  | { action: "apply_rotate"; degrees: number };

type VideoEditMode = "trim" | "rotate" | "split";

type VideoCutterProps = {
  open: boolean;
  videoPath: string | null;
  durationSecsHint?: number;
  onClose: () => void;
  onComplete: (result: VideoCutterResult) => void;
};

const VIDEO_MODES: MediaEditModeOption<VideoEditMode>[] = [
  {
    id: "trim",
    label: "Zuschnitt",
    icon: <Crop className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "rotate",
    label: "Drehen",
    icon: <RotateCw className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "split",
    label: "Teilen",
    icon: <SplitSquareHorizontal className="h-4 w-4" strokeWidth={2} />,
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
  const playerRef = useRef<VideoPlayerHandle>(null);
  const committedRef = useRef(false);
  const showWarning = useUiStore((s) => s.showWarning);
  const mediaRevision = useVideoStore((s) =>
    videoPath ? s.getMediaRevision(videoPath) : 0,
  );
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

  const doneEnabled =
    mode === "trim"
      ? trimDirty
      : mode === "rotate"
        ? rotatePending
        : splitValid;

  useEffect(() => {
    if (!open) {
      rangeInitializedRef.current = false;
      setStartMs(0);
      setEndMs(0);
      setPendingRotateDeg(0);
      setPlayheadMs(0);
      setMode("trim");
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
    if (next === mode) return;
    // Leaving a mode drops its pending preview state (Photos discards uncommitted tool tweaks).
    if (mode === "rotate") setPendingRotateDeg(0);
    if (mode === "trim") {
      const dur = playerRef.current?.getDurationMs() || durationMs;
      setStartMs(0);
      setEndMs(dur);
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

  function resetRange() {
    const dur = playerRef.current?.getDurationMs() || durationMs;
    setStartMs(0);
    setEndMs(dur);
    playerRef.current?.seekMs(0);
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

  function handleDone() {
    if (mode === "trim") applyTrim();
    else if (mode === "rotate") applyRotate();
    else applySplit();
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

  const controls =
    mode === "trim" ? (
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="font-mono text-[12px] tabular-nums text-muted">
          {formatPlayerTimeMs(startMs)} –{" "}
          {formatPlayerTimeMs(endMs > 0 ? endMs : durationMs)}
        </p>
        <button
          type="button"
          onClick={resetRange}
          className="text-[13px] font-medium text-accent transition hover:text-foreground"
        >
          {t("common.actions.reset")}
        </button>
      </div>
    ) : mode === "rotate" ? (
      <MediaEditRotateBar
        degrees={pendingRotateDeg}
        onRotateCw={() => setPendingRotateDeg((d) => d + 90)}
        onRotateCcw={() => setPendingRotateDeg((d) => d - 90)}
        onReset={() => setPendingRotateDeg(0)}
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
      modes={VIDEO_MODES}
      onModeChange={switchMode}
      onCancel={cancel}
      onDone={handleDone}
      doneEnabled={doneEnabled}
      controls={controls}
    >
      <div className="flex h-full min-h-0 w-full flex-col">
        <VideoPlayer
          ref={playerRef}
          fillAvailable
          className="min-h-0 flex-1"
          chrome={trimActive ? "trim" : "playback"}
          emphasizePlayhead={mode === "split"}
          snapSeekMs={
            mode === "split" && keyframesSecs.length > 0
              ? (ms) => {
                  const nearest = nearestKeyframe(keyframesSecs, ms / 1000);
                  return nearest != null ? nearest * 1000 : ms;
                }
              : undefined
          }
          srcPath={open ? videoPath : null}
          cacheKey={
            videoPath
              ? `${useVideoStore.getState().getMediaRevision(videoPath)}-${durationMs}`
              : null
          }
          keepRange={trimActive ? keepRange : undefined}
          keyframeMarks={
            trimActive || mode === "split" ? keyframeMarks : undefined
          }
          filmstripFrames={
            trimActive || mode === "split" ? filmstripFrames : undefined
          }
          // Always pass a number (0 outside rotate) so absolute centering stays
          // mounted — toggling null↔layout + transition-transform slides the video.
          previewRotateDeg={pendingRotateDeg}
          previewRotateTransition={rotateActive}
          onTrimChange={trimActive ? handleTrimChange : undefined}
          onTrimCommit={trimActive ? handleTrimCommit : undefined}
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
      </div>
    </MediaEditShell>
  );
}
