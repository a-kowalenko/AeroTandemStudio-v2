import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import { Pause, Play, Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { Button } from "./ui/button";
import { videoFileSrc } from "../lib/mediaUrl";
import { cn } from "../lib/utils";

function VolumeLevelIcon({
  volume,
  muted,
  className,
}: {
  volume: number;
  muted: boolean;
  className?: string;
}) {
  if (muted || volume <= 0) return <VolumeX className={className} />;
  if (volume <= 0.1) return <Volume className={className} />;
  if (volume < 0.5) return <Volume1 className={className} />;
  return <Volume2 className={className} />;
}

export type VideoPlayerHandle = {
  getCurrentTimeMs: () => number;
  getDurationMs: () => number;
  seekMs: (ms: number) => void;
  pause: () => void;
  play: () => void;
};

export type TrimHandle = "start" | "end";

type VideoPlayerProps = {
  /** Absolute filesystem path (converted via media URI scheme). */
  srcPath: string | null;
  /**
   * Cache-bust token when the file is overwritten in place (trim).
   * Changes force a new media URL so the browser does not reuse the old body.
   */
  cacheKey?: string | number | null;
  className?: string;
  /** Called when currentTime / duration update. */
  onTimeUpdate?: (currentMs: number, durationMs: number) => void;
  /** Fired when playback reaches the end. */
  onEnded?: () => void;
  /** Start playback once metadata/data is ready (e.g. after advancing clips). */
  autoPlay?: boolean;
  /** Optional overlay marks for keep-range (0–1). */
  keepRange?: { start: number; end: number } | null;
  /**
   * When set with keepRange, shows draggable trim handles.
   * Drag seeks the preview to the handle time; commit fires on pointer-up.
   */
  onTrimChange?: (handle: TrimHandle, ms: number) => void;
  onTrimCommit?: (handle: TrimHandle, ms: number) => void;
  /** Keyframe markers as ratios 0–1 (optional visual ticks). */
  keyframeMarks?: number[];
  disabled?: boolean;
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const frac = Math.floor(ms % 1000);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${frac
    .toString()
    .padStart(3, "0")}`;
}

const HANDLE_HIT_PX = 14;
const MIN_RANGE_MS = 100;

/**
 * HTML5 video player (Phase-9 interim — libmpv deferred).
 * Supports seek, play/pause, volume, and a custom timeline with keep-range / trim handles.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer(
    {
      srcPath,
      cacheKey,
      className,
      onTimeUpdate,
      onEnded,
      autoPlay,
      keepRange,
      onTrimChange,
      onTrimCommit,
      keyframeMarks,
      disabled,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [volume, setVolume] = useState(0.7);
    const [muted, setMuted] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [src, setSrc] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const dragModeRef = useRef<"seek" | TrimHandle | null>(null);
    const autoPlayRef = useRef(autoPlay);
    autoPlayRef.current = autoPlay;
    const volumeRef = useRef(volume);
    volumeRef.current = volume;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const keepRangeRef = useRef(keepRange);
    keepRangeRef.current = keepRange;
    const durationMsRef = useRef(durationMs);
    durationMsRef.current = durationMs;
    const onTrimChangeRef = useRef(onTrimChange);
    onTrimChangeRef.current = onTrimChange;
    const onTrimCommitRef = useRef(onTrimCommit);
    onTrimCommitRef.current = onTrimCommit;

    useImperativeHandle(ref, () => ({
      getCurrentTimeMs: () => {
        const v = videoRef.current;
        return v ? v.currentTime * 1000 : 0;
      },
      getDurationMs: () => {
        const v = videoRef.current;
        return v && Number.isFinite(v.duration) ? v.duration * 1000 : durationMs;
      },
      seekMs: (ms: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, ms / 1000);
        setCurrentMs(ms);
      },
      pause: () => {
        videoRef.current?.pause();
      },
      play: () => {
        void videoRef.current?.play();
      },
    }));

    useEffect(() => {
      setPlaying(false);
      setCurrentMs(0);
      setDurationMs(0);
      setSrc(null);
      setLoadError(null);
      if (!srcPath) return;
      let cancelled = false;
      void videoFileSrc(srcPath, cacheKey)
        .then((url) => {
          if (!cancelled) setSrc(url);
        })
        .catch(() => {
          if (!cancelled) {
            setSrc(null);
            setLoadError("Video-URL konnte nicht geladen werden.");
          }
        });
      return () => {
        cancelled = true;
      };
    }, [srcPath, cacheKey]);

    // Re-apply on `src` too: `key={src}` remounts <video> at browser defaults.
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      v.muted = muted;
      v.volume = muted ? 0 : volume;
    }, [volume, muted, src]);

    const emitTime = useCallback(
      (cur: number, dur: number) => {
        setCurrentMs(cur);
        if (dur > 0) setDurationMs(dur);
        onTimeUpdate?.(cur, dur > 0 ? dur : durationMs);
      },
      [onTimeUpdate, durationMs],
    );

    function togglePlay() {
      const v = videoRef.current;
      if (!v || disabled) return;
      if (v.paused) void v.play();
      else v.pause();
    }

    function msFromClientX(clientX: number): number | null {
      const bar = barRef.current;
      const dur = durationMsRef.current;
      if (!bar || !dur) return null;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * dur;
    }

    function seekFromClientX(clientX: number) {
      const v = videoRef.current;
      const ms = msFromClientX(clientX);
      if (ms == null || !v) return;
      v.currentTime = ms / 1000;
      emitTime(ms, durationMsRef.current);
    }

    function applyTrimDrag(handle: TrimHandle, clientX: number) {
      const ms = msFromClientX(clientX);
      const v = videoRef.current;
      const dur = durationMsRef.current;
      const kr = keepRangeRef.current;
      if (ms == null || !v || !dur || !kr) return;

      let next = ms;
      if (handle === "start") {
        const endMs = kr.end * dur;
        next = Math.max(0, Math.min(ms, endMs - MIN_RANGE_MS));
      } else {
        const startMs = kr.start * dur;
        next = Math.min(dur, Math.max(ms, startMs + MIN_RANGE_MS));
      }

      v.pause();
      v.currentTime = next / 1000;
      emitTime(next, dur);
      onTrimChangeRef.current?.(handle, next);
    }

    function hitTestHandle(clientX: number): TrimHandle | "seek" {
      const bar = barRef.current;
      const kr = keepRangeRef.current;
      if (!bar || !kr || !onTrimChangeRef.current) return "seek";
      const rect = bar.getBoundingClientRect();
      const x = clientX - rect.left;
      const startX = kr.start * rect.width;
      const endX = kr.end * rect.width;
      if (Math.abs(x - startX) <= HANDLE_HIT_PX) return "start";
      if (Math.abs(x - endX) <= HANDLE_HIT_PX) return "end";
      return "seek";
    }

    const playhead = durationMs > 0 ? currentMs / durationMs : 0;
    const keepStart = keepRange?.start ?? 0;
    const keepEnd = keepRange?.end ?? 1;
    const trimEditable = Boolean(keepRange && onTrimChange);

    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
          {src ? (
            <video
              key={src}
              ref={videoRef}
              className="h-full w-full object-contain"
              src={src}
              playsInline
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                onEnded?.();
              }}
              onError={(e) => {
                const code = e.currentTarget.error?.code;
                // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED — typical on Linux without GStreamer codecs
                if (code === 4) {
                  setLoadError(
                    "Video nicht abspielbar (Codec/WebView). Unter Linux: GStreamer-Plugins installieren (gstreamer1.0-libav, plugins-good/bad).",
                  );
                } else {
                  setLoadError("Video konnte nicht geladen werden.");
                }
              }}
              onLoadedMetadata={(e) => {
                setLoadError(null);
                e.currentTarget.muted = mutedRef.current;
                e.currentTarget.volume = mutedRef.current ? 0 : volumeRef.current;
                const d = e.currentTarget.duration * 1000;
                emitTime(0, d);
                if (autoPlayRef.current && !disabled) {
                  void e.currentTarget.play().catch(() => {
                    /* autoplay may be blocked until user gesture */
                  });
                }
              }}
              onTimeUpdate={(e) => {
                if (dragging) return;
                const v = e.currentTarget;
                emitTime(v.currentTime * 1000, v.duration * 1000);
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/70">
              Kein Video
            </div>
          )}
          {loadError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 px-4 text-center text-xs text-white/90">
              {loadError}
            </div>
          )}
        </div>

        <div
          ref={barRef}
          className={cn(
            "relative h-8 touch-none select-none rounded bg-[#555]",
            disabled && "pointer-events-none opacity-50",
            trimEditable ? "cursor-default" : "cursor-pointer",
          )}
          onPointerDown={(e) => {
            if (disabled) return;
            const mode = hitTestHandle(e.clientX);
            dragModeRef.current = mode;
            setDragging(true);
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            if (mode === "seek") seekFromClientX(e.clientX);
            else applyTrimDrag(mode, e.clientX);
          }}
          onPointerMove={(e) => {
            if (!dragging || !dragModeRef.current) return;
            if (dragModeRef.current === "seek") seekFromClientX(e.clientX);
            else applyTrimDrag(dragModeRef.current, e.clientX);
          }}
          onPointerUp={(e) => {
            const mode = dragModeRef.current;
            if (mode === "start" || mode === "end") {
              const ms = msFromClientX(e.clientX);
              if (ms != null) {
                const dur = durationMsRef.current;
                const kr = keepRangeRef.current;
                let committed = ms;
                if (kr && dur > 0) {
                  if (mode === "start") {
                    committed = Math.max(
                      0,
                      Math.min(ms, kr.end * dur - MIN_RANGE_MS),
                    );
                  } else {
                    committed = Math.min(
                      dur,
                      Math.max(ms, kr.start * dur + MIN_RANGE_MS),
                    );
                  }
                }
                onTrimCommitRef.current?.(mode, committed);
              }
            }
            dragModeRef.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            dragModeRef.current = null;
            setDragging(false);
          }}
        >
          <div
            className="absolute inset-y-[28%] left-0 bg-[#888]"
            style={{ width: `${keepStart * 100}%` }}
          />
          <div
            className="absolute inset-y-[28%] bg-[#0078d4]"
            style={{
              left: `${keepStart * 100}%`,
              width: `${Math.max(0, keepEnd - keepStart) * 100}%`,
            }}
          />
          <div
            className="absolute inset-y-[28%] right-0 bg-[#888]"
            style={{ left: `${keepEnd * 100}%`, right: 0 }}
          />

          {keyframeMarks?.map((r) => (
            <div
              key={`kf-${r}`}
              className="pointer-events-none absolute inset-y-[18%] w-px bg-white/35"
              style={{ left: `${r * 100}%` }}
            />
          ))}

          {trimEditable && (
            <>
              <div
                className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize"
                style={{ left: `${keepStart * 100}%` }}
                aria-hidden
              >
                <div className="absolute inset-y-0.5 left-1/2 w-1.5 -translate-x-1/2 rounded-sm bg-white shadow" />
              </div>
              <div
                className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize"
                style={{ left: `${keepEnd * 100}%` }}
                aria-hidden
              >
                <div className="absolute inset-y-0.5 left-1/2 w-1.5 -translate-x-1/2 rounded-sm bg-white shadow" />
              </div>
            </>
          )}

          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-[#E74C3C]"
            style={{ left: `${playhead * 100}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled || !src}
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span className="min-w-[9rem] font-mono text-xs text-muted">
            {formatMs(currentMs)} / {formatMs(durationMs)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              className="rounded p-0.5 text-muted hover:text-foreground disabled:opacity-50"
              aria-label={muted || volume === 0 ? "Ton an" : "Stumm"}
              onClick={() => {
                if (muted || volume === 0) {
                  setMuted(false);
                  if (volume === 0) setVolume(0.7);
                } else {
                  setMuted(true);
                }
              }}
            >
              <VolumeLevelIcon
                volume={volume}
                muted={muted}
                className="h-3.5 w-3.5"
              />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              disabled={disabled}
              onChange={(e) => {
                const next = Number(e.target.value);
                setVolume(next);
                setMuted(next === 0);
              }}
              className="w-20"
              aria-label="Lautstärke"
            />
          </div>
        </div>
      </div>
    );
  },
);

export { formatMs as formatPlayerTimeMs };
