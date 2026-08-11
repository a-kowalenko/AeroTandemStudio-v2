import { useEffect, useRef, useState } from "react";
import { Scissors, SplitSquareHorizontal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import {
  VideoPlayer,
  formatPlayerTimeMs,
  type TrimHandle,
  type VideoPlayerHandle,
} from "./VideoPlayer";
import { useUiStore } from "../store/uiStore";
import { listVideoKeyframes, getVideoFilmstrip } from "../lib/tauri";
import { useVideoStore } from "../store/videoStore";
import {
  keyframeAtOrAfter,
  keyframeAtOrBefore,
  nearestKeyframe,
} from "../lib/keyframes";

export type VideoCutterResult =
  | { action: "cancel" }
  | { action: "apply_trim"; startMs: number; endMs: number }
  | { action: "apply_split"; splitMs: number };

type VideoCutterProps = {
  open: boolean;
  videoPath: string | null;
  durationSecsHint?: number;
  onClose: () => void;
  onComplete: (result: VideoCutterResult) => void;
};

/**
 * Modal cutter UI: Apple Photos–style filmstrip trim with live preview seek.
 * On release, handles snap to keyframes for stream-copy-friendly cuts.
 * Confirm applies trim/split immediately (caller runs FFmpeg).
 */
export function VideoCutter({
  open,
  videoPath,
  durationSecsHint,
  onClose,
  onComplete,
}: VideoCutterProps) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const committedRef = useRef(false);
  const showWarning = useUiStore((s) => s.showWarning);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [durationMs, setDurationMs] = useState(
    durationSecsHint && durationSecsHint > 0 ? durationSecsHint * 1000 : 0,
  );
  const [keyframesSecs, setKeyframesSecs] = useState<number[]>([]);
  const [kfLoading, setKfLoading] = useState(false);
  const [kfError, setKfError] = useState<string | null>(null);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const rangeInitializedRef = useRef(false);
  const startMsRef = useRef(startMs);
  const endMsRef = useRef(endMs);
  startMsRef.current = startMs;
  endMsRef.current = endMs;

  useEffect(() => {
    if (!open) {
      rangeInitializedRef.current = false;
      setKeyframesSecs([]);
      setKfError(null);
      setKfLoading(false);
      setFilmstripFrames([]);
      setStartMs(0);
      setEndMs(0);
      return;
    }
    const hintMs =
      durationSecsHint && durationSecsHint > 0 ? durationSecsHint * 1000 : 0;
    if (hintMs > 0) {
      setDurationMs(hintMs);
      setStartMs(0);
      setEndMs(hintMs);
      rangeInitializedRef.current = true;
    }
  }, [open, videoPath, durationSecsHint]);

  useEffect(() => {
    if (!open || !videoPath) return;
    let cancelled = false;
    setKfLoading(true);
    setKfError(null);
    const durationHint =
      durationSecsHint && durationSecsHint > 0 ? durationSecsHint : null;
    void listVideoKeyframes(videoPath, durationHint)
      .then((times) => {
        if (cancelled) return;
        setKeyframesSecs(times);
        setKfLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setKeyframesSecs([]);
        setKfLoading(false);
        setKfError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, videoPath, durationSecsHint]);

  useEffect(() => {
    if (!open || !videoPath) return;
    let cancelled = false;
    setFilmstripFrames([]);
    const durationHint =
      durationSecsHint && durationSecsHint > 0 ? durationSecsHint : null;
    void getVideoFilmstrip(videoPath, 14, 56, durationHint)
      .then((frames) => {
        if (!cancelled) setFilmstripFrames(frames);
      })
      .catch(() => {
        if (!cancelled) setFilmstripFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, videoPath, durationSecsHint]);

  function finish(result: VideoCutterResult) {
    committedRef.current = true;
    playerRef.current?.pause();
    onComplete(result);
    onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      committedRef.current = false;
      return;
    }
    if (!committedRef.current) {
      onComplete({ action: "cancel" });
    }
    committedRef.current = false;
    onClose();
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

    const nearFull =
      s <= 50 && dur > 0 && Math.abs(e - dur) <= 50;
    if (nearFull || e - s < 100) {
      showWarning(
        nearFull
          ? "Der behaltene Bereich ist das ganze Video. Ziehen Sie die Handles, um zuzuschneiden."
          : "Der behaltene Bereich ist zu kurz.",
        "Keine Änderung",
      );
      return;
    }
    finish({ action: "apply_trim", startMs: s, endMs: e });
  }

  function applySplit() {
    let splitMs = playerRef.current?.getCurrentTimeMs() ?? 0;
    const total = playerRef.current?.getDurationMs() || durationMs;
    if (keyframesSecs.length > 0) {
      const nearest = nearestKeyframe(keyframesSecs, splitMs / 1000);
      if (nearest != null) splitMs = nearest * 1000;
    }
    if (splitMs <= 100 || splitMs >= total - 100) {
      showWarning(
        "Sie können nicht zu nah am Anfang oder Ende des Clips teilen.",
        "Ungültiger Split-Punkt",
      );
      return;
    }
    finish({ action: "apply_split", splitMs });
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" />
            Video schneiden
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {videoPath ?? "—"}
          </DialogDescription>
        </DialogHeader>

        <VideoPlayer
          ref={playerRef}
          srcPath={open ? videoPath : null}
          cacheKey={
            videoPath
              ? `${useVideoStore.getState().getMediaRevision(videoPath)}-${durationMs}`
              : null
          }
          keepRange={keepRange}
          keyframeMarks={keyframeMarks}
          filmstripFrames={filmstripFrames}
          onTrimChange={handleTrimChange}
          onTrimCommit={handleTrimCommit}
          onTimeUpdate={(_c, d) => {
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

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-mono">
            Start {formatPlayerTimeMs(startMs)} · Ende{" "}
            {formatPlayerTimeMs(endMs > 0 ? endMs : durationMs)}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={resetRange}>
            Auswahl zurücksetzen
          </Button>
          <span className="ml-auto">
            {kfLoading
              ? "Keyframes werden geladen…"
              : kfError
                ? "Keyframe-Snap nicht verfügbar"
                : keyframesSecs.length > 0
                  ? `${keyframesSecs.length} Keyframes · Snap aktiv`
                  : "Keine Keyframes gefunden"}
          </span>
        </div>

        <p className="text-xs text-muted">
          Handles ziehen: Vorschau folgt dem Schnittpunkt. Beim Loslassen
          Einrasten auf Keyframes (Stream-Copy). Timeline tippen setzt den
          Playhead zum Teilen.
        </p>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
            Abbrechen
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={applySplit}>
              <SplitSquareHorizontal className="h-4 w-4" />
              Teilen
            </Button>
            <Button type="button" onClick={applyTrim}>
              <Scissors className="h-4 w-4" />
              Trim übernehmen
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
