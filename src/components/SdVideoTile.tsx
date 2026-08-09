import { useEffect, useRef, useState } from "react";
import { Film, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { videoFileSrc } from "../lib/mediaUrl";
import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

const HOVER_PLAY_DELAY_MS = 180;

type Props = {
  path: string;
  filename: string;
  sizeLabel: string;
  thumbUrl?: string;
  selected: boolean;
  alreadyProcessed?: boolean;
  /** Another tile (or this one) owns the single active session. */
  isActive: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onToggleSelect: () => void;
  tileRef?: (el: HTMLElement | null) => void;
};

function formatClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * SD selector video tile: YouTube-style muted hover preview, pinned play
 * (keeps playing after mouse leave), scrub bar, mute/volume, fullscreen.
 * Selection is only via click outside `[data-controls]`.
 */
export function SdVideoTile({
  path,
  filename,
  sizeLabel,
  thumbUrl,
  selected,
  alreadyProcessed,
  isActive,
  onActivate,
  onDeactivate,
  onToggleSelect,
  tileRef,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [wantPreview, setWantPreview] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.7);
  const [showVolume, setShowVolume] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const showVideo = wantPreview || pinned;
  const showControls = hovering || pinned || playing;

  // Resolve media URL when preview is wanted.
  useEffect(() => {
    if (!showVideo) {
      setSrc(null);
      setLoadError(false);
      return;
    }
    let cancelled = false;
    setLoadError(false);
    void videoFileSrc(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showVideo, path]);

  // Another tile took over → unpin and stop.
  useEffect(() => {
    if (isActive) return;
    setPinned(false);
    setWantPreview(false);
    setPlaying(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    setSrc(null);
  }, [isActive]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = muted ? 0 : volume;
  }, [muted, volume, src]);

  // Autoplay when preview becomes ready (hover or pinned).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    if (!(wantPreview || pinned)) return;
    void v.play().catch(() => {
      /* autoplay may fail until gesture */
    });
  }, [src, wantPreview, pinned]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
    };
  }, []);

  function clearHoverTimer() {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function onMediaEnter() {
    setHovering(true);
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setWantPreview(true);
      onActivate();
    }, HOVER_PLAY_DELAY_MS);
  }

  function onMediaLeave() {
    setHovering(false);
    setShowVolume(false);
    clearHoverTimer();
    if (pinned) return;
    setWantPreview(false);
    setPlaying(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    if (isActive) onDeactivate();
  }

  function togglePlay(e: React.SyntheticEvent) {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v && !src) {
      setPinned(true);
      setWantPreview(true);
      onActivate();
      return;
    }
    if (!v) return;
    if (v.paused) {
      setPinned(true);
      setWantPreview(true);
      onActivate();
      void v.play().catch(() => undefined);
    } else {
      v.pause();
      // Stay pinned so leave does not tear down; user can resume.
      setPinned(true);
    }
  }

  function seekFromClientX(clientX: number) {
    const bar = barRef.current;
    const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * duration;
    setCurrent(v.currentTime);
  }

  async function toggleFullscreen(e: React.SyntheticEvent) {
    e.stopPropagation();
    setPinned(true);
    setWantPreview(true);
    onActivate();
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.fullscreenElement === v) {
        await document.exitFullscreen();
      } else {
        await v.requestFullscreen();
      }
    } catch {
      /* fullscreen may be blocked */
    }
  }

  const playhead = duration > 0 ? current / duration : 0;

  return (
    <div
      data-tile
      ref={tileRef}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-md text-left transition",
        selected
          ? "border-2 border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
          : "border border-border/70",
        alreadyProcessed && "opacity-70",
        (pinned || playing) &&
          isActive &&
          !selected &&
          "ring-2 ring-primary/50",
      )}
    >
      <div
        className="relative flex aspect-video items-center justify-center bg-black/90"
        onMouseEnter={onMediaEnter}
        onMouseLeave={onMediaLeave}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-controls]")) return;
          onToggleSelect();
        }}
      >
        <div
          data-controls
          className="absolute top-1.5 left-1.5 z-10"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect()}
            aria-label={`${filename} auswählen`}
            className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
          />
        </div>
        {showVideo && src && !loadError ? (
          <video
            key={src}
            ref={videoRef}
            className="h-full w-full object-cover"
            src={src}
            playsInline
            muted={muted}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setPinned(false);
              setWantPreview(false);
              if (isActive) onDeactivate();
            }}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              setCurrent(0);
            }}
            onTimeUpdate={(e) => {
              if (dragging) return;
              setCurrent(e.currentTarget.currentTime);
              const d = e.currentTarget.duration;
              if (Number.isFinite(d)) setDuration(d);
            }}
            onError={() => setLoadError(true)}
          />
        ) : thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <Film className="h-8 w-8 text-muted" />
        )}

        {loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 px-2 text-center text-[10px] text-white/90">
            Keine Vorschau
          </div>
        )}

        {/* Center play/pause — container ignores hits so clicks elsewhere still select */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity",
            showControls ? "opacity-100" : "opacity-0",
          )}
        >
          <button
            type="button"
            data-controls
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/70",
              showControls ? "pointer-events-auto" : "pointer-events-none",
            )}
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
          </button>
        </div>

        {/* Top-right: mute / volume / fullscreen */}
        <div
          data-controls
          className={cn(
            "absolute top-1 right-1 flex items-center gap-0.5 transition-opacity",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="relative flex items-center"
            onMouseEnter={() => setShowVolume(true)}
            onMouseLeave={() => setShowVolume(false)}
          >
            {showVolume && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label="Lautstärke"
                className="mr-1 h-1 w-14 cursor-pointer accent-white"
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
              />
            )}
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded bg-black/55 text-white hover:bg-black/70"
              aria-label={muted || volume === 0 ? "Ton an" : "Stumm"}
              onClick={(e) => {
                e.stopPropagation();
                if (muted || volume === 0) {
                  setMuted(false);
                  if (volume === 0) setVolume(0.7);
                } else {
                  setMuted(true);
                }
              }}
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded bg-black/55 text-white hover:bg-black/70"
            aria-label="Vollbild"
            onClick={(e) => void toggleFullscreen(e)}
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Bottom timeline */}
        <div
          data-controls
          className={cn(
            "absolute inset-x-0 bottom-0 transition-opacity",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(hovering || pinned || playing) && duration > 0 && (
            <div className="px-1.5 pb-0.5 text-right font-mono text-[9px] text-white/90 drop-shadow">
              {formatClock(current)} / {formatClock(duration)}
            </div>
          )}
          <div
            ref={barRef}
            className="relative h-3 cursor-pointer bg-black/40 px-1"
            onPointerDown={(e) => {
              e.stopPropagation();
              setDragging(true);
              setPinned(true);
              setWantPreview(true);
              onActivate();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              seekFromClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (!dragging) return;
              seekFromClientX(e.clientX);
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
          >
            <div className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-white/35" />
            <div
              className="absolute top-1/2 left-1 h-0.5 -translate-y-1/2 rounded-full bg-white/90"
              style={{ width: `calc((100% - 8px) * ${playhead})` }}
            />
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
              style={{ left: `calc(4px + (100% - 8px) * ${playhead})` }}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        className="truncate px-2 py-1 text-left text-[11px] hover:bg-black/5"
        onClick={onToggleSelect}
        title={filename}
      >
        {filename}
      </button>
      <button
        type="button"
        className="px-2 pb-1 text-left text-[10px] text-muted hover:bg-black/5"
        onClick={onToggleSelect}
      >
        {sizeLabel}
        {alreadyProcessed ? " · bekannt" : ""}
      </button>
    </div>
  );
}
