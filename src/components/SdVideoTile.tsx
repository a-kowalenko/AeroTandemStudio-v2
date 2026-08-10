import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {
  Film,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { videoFileSrc } from "../lib/mediaUrl";
import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

const HOVER_PLAY_DELAY_MS = 180;

type Props = {
  path: string;
  filename: string;
  sizeLabel: string;
  thumbUrl?: string;
  thumbQuality?: "lq" | "hq";
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

async function requestElFullscreen(el: HTMLElement): Promise<boolean> {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  try {
    if (document.fullscreenElement === el) return true;
    if (typeof el.requestFullscreen === "function") {
      await el.requestFullscreen();
      return document.fullscreenElement === el || !!document.fullscreenElement;
    }
    if (typeof anyEl.webkitRequestFullscreen === "function") {
      await anyEl.webkitRequestFullscreen();
      return true;
    }
  } catch (err) {
    console.warn("Fullscreen API failed:", err);
  }
  return false;
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
  thumbQuality,
  selected,
  alreadyProcessed,
  isActive,
  onActivate,
  onDeactivate,
  onToggleSelect,
  tileRef,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const immersiveVideoRef = useRef<HTMLVideoElement>(null);
  const mediaShellRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const immersiveBarRef = useRef<HTMLDivElement>(null);
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
  /** Pseudo-fullscreen when Fullscreen API is blocked (common in dialogs / WebView). */
  const [immersive, setImmersive] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);

  const showVideo = wantPreview || pinned || immersive;
  const showControls = hovering || pinned || playing || immersive;
  const isExpanded = immersive || nativeFs;

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
    setImmersive(false);
    setNativeFs(false);
    if (document.fullscreenElement && mediaShellRef.current) {
      const fs = document.fullscreenElement;
      if (fs === mediaShellRef.current || fs === videoRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    }
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
    const apply = (v: HTMLVideoElement | null) => {
      if (!v) return;
      v.muted = muted;
      v.volume = muted ? 0 : volume;
    };
    apply(videoRef.current);
    apply(immersiveVideoRef.current);
  }, [muted, volume, src, immersive]);

  // Autoplay when preview becomes ready (hover or pinned / immersive).
  useEffect(() => {
    const v = immersive ? immersiveVideoRef.current : videoRef.current;
    if (!v || !src) return;
    if (!(wantPreview || pinned || immersive)) return;
    void v.play().catch(() => {
      /* autoplay may fail until gesture */
    });
  }, [src, wantPreview, pinned, immersive]);

  // Sync playback position into immersive player on enter.
  useEffect(() => {
    if (!immersive || !src) return;
    const tile = videoRef.current;
    const full = immersiveVideoRef.current;
    if (!full) return;
    const t = tile?.currentTime ?? current;
    const wasPlaying = tile ? !tile.paused : playing;
    tile?.pause();
    const seekAndPlay = () => {
      try {
        full.currentTime = t;
      } catch {
        /* ignore */
      }
      if (wasPlaying || pinned) void full.play().catch(() => undefined);
    };
    if (full.readyState >= 1) seekAndPlay();
    else full.addEventListener("loadedmetadata", seekAndPlay, { once: true });
  }, [immersive, src]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onFsChange() {
      const shell = mediaShellRef.current;
      const v = videoRef.current;
      const active =
        document.fullscreenElement === shell || document.fullscreenElement === v;
      setNativeFs(active);
      if (!active && !immersive) {
        /* native FS exited */
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [immersive]);

  useEffect(() => {
    if (!immersive) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        exitExpanded();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [immersive]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (pinned || immersive) return;
    setWantPreview(false);
    setPlaying(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    if (isActive) onDeactivate();
  }

  function togglePlay(e: SyntheticEvent) {
    e.stopPropagation();
    const v = immersive ? immersiveVideoRef.current : videoRef.current;
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
      setPinned(true);
    }
  }

  function seekFromClientX(
    clientX: number,
    bar: HTMLDivElement | null,
    video: HTMLVideoElement | null,
  ) {
    if (!bar || !video || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
    setCurrent(video.currentTime);
  }

  function exitExpanded() {
    const t = immersiveVideoRef.current?.currentTime ?? current;
    const wasPlaying = immersiveVideoRef.current
      ? !immersiveVideoRef.current.paused
      : playing;
    setImmersive(false);
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    setNativeFs(false);
    setPinned(true);
    setWantPreview(true);
    // Restore tile video time after immersive unmounts
    requestAnimationFrame(() => {
      const v = videoRef.current;
      if (!v) return;
      try {
        v.currentTime = t;
      } catch {
        /* ignore */
      }
      if (wasPlaying) void v.play().catch(() => undefined);
    });
  }

  async function toggleFullscreen(e: SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
    setPinned(true);
    setWantPreview(true);
    onActivate();

    // Exit if already expanded
    if (immersive || document.fullscreenElement) {
      exitExpanded();
      return;
    }

    // Prefer native Fullscreen API on the shell — always mounted, called
    // synchronously within the user gesture (no deferred retry).
    const shell = mediaShellRef.current;
    if (shell) {
      const ok = await requestElFullscreen(shell);
      if (ok) {
        setNativeFs(true);
        return;
      }
    }

    // Fallback: app-level immersive overlay (portaled — avoids dialog transform / WebView blocks)
    setImmersive(true);
  }

  const playhead = duration > 0 ? current / duration : 0;

  function renderTransportControls(opts: {
    bar: RefObject<HTMLDivElement | null>;
    video: RefObject<HTMLVideoElement | null>;
    large?: boolean;
  }) {
    return (
      <>
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity [transform:translateZ(1px)]",
            showControls ? "opacity-100" : "opacity-0",
          )}
        >
          <button
            type="button"
            data-controls
            className={cn(
              "flex items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/70",
              opts.large ? "h-14 w-14" : "h-9 w-9",
              showControls ? "pointer-events-auto" : "pointer-events-none",
            )}
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
            onPointerDown={(ev) => ev.stopPropagation()}
          >
            {playing ? (
              <Pause className={opts.large ? "h-6 w-6" : "h-4 w-4"} />
            ) : (
              <Play
                className={cn(
                  opts.large ? "h-6 w-6" : "h-4 w-4",
                  "fill-current",
                )}
              />
            )}
          </button>
        </div>

        <div
          data-controls
          className={cn(
            "absolute top-1 right-1 z-10 flex items-center gap-0.5 transition-opacity [transform:translateZ(1px)]",
            opts.large && "top-3 right-3 gap-1",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => ev.stopPropagation()}
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
                className={cn(
                  "mr-1 h-1 cursor-pointer accent-white",
                  opts.large ? "w-24" : "w-14",
                )}
                onChange={(ev) => {
                  const next = Number(ev.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
              />
            )}
            <button
              type="button"
              className={cn(
                "flex items-center justify-center rounded bg-black/55 text-white hover:bg-black/70",
                opts.large ? "h-9 w-9" : "h-7 w-7",
              )}
              aria-label={muted || volume === 0 ? "Ton an" : "Stumm"}
              onClick={(ev) => {
                ev.stopPropagation();
                if (muted || volume === 0) {
                  setMuted(false);
                  if (volume === 0) setVolume(0.7);
                } else {
                  setMuted(true);
                }
              }}
            >
              {muted || volume === 0 ? (
                <VolumeX className={opts.large ? "h-4 w-4" : "h-3.5 w-3.5"} />
              ) : (
                <Volume2 className={opts.large ? "h-4 w-4" : "h-3.5 w-3.5"} />
              )}
            </button>
          </div>
          <button
            type="button"
            className={cn(
              "flex items-center justify-center rounded bg-black/55 text-white hover:bg-black/70",
              opts.large ? "h-9 w-9" : "h-7 w-7",
            )}
            aria-label={isExpanded ? "Vollbild beenden" : "Vollbild"}
            onClick={(ev) => void toggleFullscreen(ev)}
          >
            {isExpanded ? (
              <Minimize className={opts.large ? "h-4 w-4" : "h-3.5 w-3.5"} />
            ) : (
              <Maximize className={opts.large ? "h-4 w-4" : "h-3.5 w-3.5"} />
            )}
          </button>
        </div>

        <div
          data-controls
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 transition-opacity [transform:translateZ(1px)]",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          {(hovering || pinned || playing || immersive) && duration > 0 && (
            <div
              className={cn(
                "px-1.5 pb-0.5 text-right font-mono text-white/90 drop-shadow",
                opts.large ? "px-3 text-xs" : "text-[9px]",
              )}
            >
              {formatClock(current)} / {formatClock(duration)}
            </div>
          )}
          <div
            ref={opts.bar}
            className={cn(
              "relative cursor-pointer bg-black/40 px-1",
              opts.large ? "h-4 px-3" : "h-3",
            )}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              setDragging(true);
              setPinned(true);
              setWantPreview(true);
              onActivate();
              (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
              seekFromClientX(ev.clientX, opts.bar.current, opts.video.current);
            }}
            onPointerMove={(ev) => {
              if (!dragging) return;
              seekFromClientX(ev.clientX, opts.bar.current, opts.video.current);
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
      </>
    );
  }

  return (
    <div
      data-tile
      data-thumb-path={path}
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
        ref={mediaShellRef}
        className={cn(
          "relative isolate flex aspect-video items-center justify-center bg-black/90",
          nativeFs && "aspect-auto h-full w-full",
        )}
        onMouseEnter={onMediaEnter}
        onMouseLeave={onMediaLeave}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-controls]")) return;
          onToggleSelect();
        }}
      >
        <div
          data-controls
          className="absolute top-1.5 left-1.5 z-10 [transform:translateZ(1px)]"
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
        {showVideo && src && !loadError && !immersive ? (
          <video
            key={src}
            ref={videoRef}
            className={cn(
              "relative z-0 h-full w-full",
              nativeFs ? "object-contain" : "object-cover",
            )}
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
        ) : thumbUrl && !immersive ? (
          <img
            src={thumbUrl}
            alt=""
            className={cn(
              "h-full w-full object-cover transition-[filter,transform] duration-300",
              thumbQuality === "lq" && "scale-[1.03] blur-[0.6px]",
            )}
            draggable={false}
          />
        ) : !immersive ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted/50 to-black/40">
            <div className="absolute inset-0 animate-pulse bg-muted/30" />
            <Film className="relative h-8 w-8 text-muted" />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-black/80">
            <Film className="h-8 w-8 text-white/40" />
          </div>
        )}

        {loadError && !immersive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/50 px-2 text-center text-[10px] text-white/90 [transform:translateZ(1px)]">
            Keine Vorschau (Codec/WebView)
          </div>
        )}

        {!immersive &&
          renderTransportControls({ bar: barRef, video: videoRef })}
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

      {immersive &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex flex-col bg-black"
            role="dialog"
            aria-modal="true"
            aria-label={`${filename} Vollbild`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              {src && !loadError ? (
                <video
                  ref={immersiveVideoRef}
                  className="max-h-full max-w-full object-contain"
                  src={src}
                  playsInline
                  muted={muted}
                  preload="auto"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => {
                    setPlaying(false);
                  }}
                  onLoadedMetadata={(e) => {
                    setDuration(e.currentTarget.duration);
                  }}
                  onTimeUpdate={(e) => {
                    if (dragging) return;
                    setCurrent(e.currentTarget.currentTime);
                    const d = e.currentTarget.duration;
                    if (Number.isFinite(d)) setDuration(d);
                  }}
                  onError={() => setLoadError(true)}
                />
              ) : (
                <div className="text-sm text-white/80">
                  {loadError ? "Keine Vorschau (Codec/WebView)" : "Lädt…"}
                </div>
              )}
              {renderTransportControls({
                bar: immersiveBarRef,
                video: immersiveVideoRef,
                large: true,
              })}
            </div>
            <div className="shrink-0 truncate px-4 py-2 text-center text-sm text-white/80">
              {filename}
              <span className="ml-2 text-xs text-white/50">Esc zum Beenden</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
