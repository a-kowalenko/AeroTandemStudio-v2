import { useEffect, useRef, useState, type SyntheticEvent } from "react";
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
import type { ThumbQuality } from "../lib/sdCard";
import { cn, isLinuxHost } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

const HOVER_PLAY_DELAY_MS = 180;
const LINUX_HOVER_PLAY_DELAY_MS = 280;
/** Sustained hover → pin (keep playing after mouse leave), like an explicit play click. */
const HOVER_PIN_DELAY_MS = 1400;
const LINUX_HOVER_PIN_DELAY_MS = 1600;
/** Hide immersive chrome after mouse idle (YouTube-style). */
const IMMERSIVE_IDLE_HIDE_MS = 2200;
/** Brief chrome after touch tap in immersive. */
const IMMERSIVE_TOUCH_CHROME_MS = 1400;
/** Linux/WebKitGTK only: spurious `ended` while scrubbing. */
const LINUX_SEEK_ENDED_GUARD_MS = 450;
const LINUX_ENDED_NEAR_END_SEC = 0.4;

/** Path of the tile currently in immersive preview — blocks hover on siblings. */
let immersiveOwnerPath: string | null = null;

function claimImmersive(path: string) {
  immersiveOwnerPath = path;
  document.documentElement.dataset.sdVideoImmersive = "1";
}

function releaseImmersive(path: string) {
  if (immersiveOwnerPath === path) {
    immersiveOwnerPath = null;
    delete document.documentElement.dataset.sdVideoImmersive;
  }
}

function isImmersiveBlocked(path: string): boolean {
  return immersiveOwnerPath != null && immersiveOwnerPath !== path;
}

type Props = {
  path: string;
  filename: string;
  sizeLabel: string;
  /** Compact capture time shown right-aligned next to file size. */
  captureLabel?: string;
  thumbUrl?: string;
  thumbQuality?: ThumbQuality;
  selected: boolean;
  alreadyProcessed?: boolean;
  /** When true and file is not known, show a Neu badge (mixed known+new list). */
  showNewBadge?: boolean;
  /** Another tile (or this one) owns the single active session. */
  isActive: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  /** Toggle or Shift-range; parent owns selection state. */
  onSelect: (e: { shiftKey: boolean }) => void;
  /** True while marquee drag is active — blocks hover preview. */
  selectionLocked?: boolean;
  /** Hover/play preview needs a real file on disk (not ICA catalog virtual paths). */
  previewEnabled?: boolean;
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
 * (keeps playing after mouse leave — via click/scrub or sustained hover),
 * scrub bar, mute/volume, fullscreen.
 * Selection is via click outside `[data-controls]` (Shift = range in parent).
 * Caption carries `data-marquee-ok` so the grid can start marquee there;
 * the media area never starts marquee.
 *
 * Fullscreen uses a body-portaled overlay (not the Fullscreen API) so hit-testing
 * works above Radix dialogs / Tauri WebView.
 */
export function SdVideoTile({
  path,
  filename,
  sizeLabel,
  captureLabel,
  thumbUrl,
  thumbQuality,
  selected,
  alreadyProcessed,
  showNewBadge = false,
  isActive,
  onActivate,
  onDeactivate,
  onSelect,
  selectionLocked = false,
  previewEnabled = true,
  tileRef,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const immersiveVideoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const immersiveBarRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const pinTimerRef = useRef<number | null>(null);
  const immersiveChromeTimerRef = useRef<number | null>(null);
  const immersiveRef = useRef(false);
  const linuxMediaGuards = useRef(isLinuxHost()).current;
  const draggingRef = useRef(false);
  const ignoreEndedUntilRef = useRef(0);
  const lastPointerTypeRef = useRef<string>("mouse");

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
  const [immersive, setImmersive] = useState(false);
  /** Immersive center + bottom chrome (mousemove / touch; idle-hides). */
  const [immersiveChrome, setImmersiveChrome] = useState(true);
  const shiftCheckboxRef = useRef(false);

  immersiveRef.current = immersive;

  const showVideo = wantPreview || pinned || immersive;
  /**
   * Tile transport chrome: hover, or paused-while-pinned (resume affordance).
   * While pinned play-without-hover, hide controls so the frame stays clear.
   */
  const showControls = hovering || (pinned && !playing);

  // Resolve media URL when preview is wanted.
  useEffect(() => {
    if (!previewEnabled || !showVideo) {
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
  }, [showVideo, path, previewEnabled]);

  // Another tile took over → unpin and stop (but never kill immersive overlay).
  useEffect(() => {
    if (isActive) return;
    if (immersiveRef.current) return;
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

  // Marquee drag: freeze hover preview so tiles under the box don't autoplay.
  useEffect(() => {
    if (!selectionLocked) return;
    clearHoverTimers();
    setHovering(false);
    setShowVolume(false);
    if (pinned || immersive) return;
    setWantPreview(false);
    setPlaying(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      try {
        v.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    if (isActive) onDeactivate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to lock edge
  }, [selectionLocked]);

  useEffect(() => {
    const apply = (v: HTMLVideoElement | null) => {
      if (!v) return;
      v.muted = muted;
      v.volume = muted ? 0 : volume;
    };
    apply(videoRef.current);
    apply(immersiveVideoRef.current);
  }, [muted, volume, src, immersive]);

  // Autoplay for hover preview / immersive only.
  // Do not depend on `pinned`: pause→setPinned(true) must not restart playback.
  // Explicit pin-play is handled in `togglePlay` / `exitExpanded`.
  useEffect(() => {
    const v = immersive ? immersiveVideoRef.current : videoRef.current;
    if (!v || !src) return;
    if (!(wantPreview || immersive)) return;
    void v.play().catch(() => {
      /* autoplay may fail until gesture */
    });
  }, [src, wantPreview, immersive]);

  // Sync playback into immersive player on enter.
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

  // While immersive: claim lock, inert underlying dialogs, Esc to close.
  useEffect(() => {
    if (!immersive) {
      releaseImmersive(path);
      return;
    }
    claimImmersive(path);
    onActivate();

    const frozen: { el: HTMLElement; pe: string }[] = [];
    const freeze = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return;
      if (frozen.some((f) => f.el === el)) return;
      frozen.push({ el, pe: el.style.pointerEvents });
      el.style.pointerEvents = "none";
      el.setAttribute("inert", "");
    };

    // Block the whole React app tree; overlay is portaled on document.body (outside #root).
    freeze(document.getElementById("root"));
    // Radix mounts dialog portals as siblings of #root — freeze those too.
    document.querySelectorAll('[role="dialog"]').forEach((node) => {
      if (node instanceof HTMLElement && node.hasAttribute("data-sd-immersive-overlay")) {
        return;
      }
      freeze(node);
      const prev = node.previousElementSibling;
      if (prev instanceof HTMLElement && getComputedStyle(prev).position === "fixed") {
        freeze(prev);
      }
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        exitExpanded();
      }
    }
    window.addEventListener("keydown", onKey, true);

    return () => {
      releaseImmersive(path);
      for (const { el, pe } of frozen) {
        el.style.pointerEvents = pe;
        el.removeAttribute("inert");
      }
      window.removeEventListener("keydown", onKey, true);
    };
  }, [immersive, path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
      if (pinTimerRef.current != null) window.clearTimeout(pinTimerRef.current);
      if (immersiveChromeTimerRef.current != null) {
        window.clearTimeout(immersiveChromeTimerRef.current);
      }
      releaseImmersive(path);
    };
  }, [path]);

  function markLinuxUserSeek() {
    if (!linuxMediaGuards) return;
    ignoreEndedUntilRef.current =
      performance.now() + LINUX_SEEK_ENDED_GUARD_MS;
  }

  function shouldAcceptEnded(v: HTMLVideoElement): boolean {
    if (!linuxMediaGuards) return true;
    if (draggingRef.current) return false;
    if (performance.now() < ignoreEndedUntilRef.current) return false;
    if (v.seeking) return false;
    const dur = v.duration;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return v.currentTime >= dur - LINUX_ENDED_NEAR_END_SEC;
  }

  function clearHoverTimers() {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (pinTimerRef.current != null) {
      window.clearTimeout(pinTimerRef.current);
      pinTimerRef.current = null;
    }
  }

  function clearImmersiveChromeTimer() {
    if (immersiveChromeTimerRef.current != null) {
      window.clearTimeout(immersiveChromeTimerRef.current);
      immersiveChromeTimerRef.current = null;
    }
  }

  function scheduleImmersiveChromeHide(delayMs = IMMERSIVE_IDLE_HIDE_MS) {
    clearImmersiveChromeTimer();
    immersiveChromeTimerRef.current = window.setTimeout(() => {
      immersiveChromeTimerRef.current = null;
      if (draggingRef.current) return;
      setImmersiveChrome(false);
      setShowVolume(false);
    }, delayMs);
  }

  /** Show immersive chrome; idle-hides so the frame stays clear. */
  function bumpImmersiveChrome(delayMs = IMMERSIVE_IDLE_HIDE_MS) {
    setImmersiveChrome(true);
    scheduleImmersiveChromeHide(delayMs);
  }

  useEffect(() => {
    if (!immersive) {
      clearImmersiveChromeTimer();
      return;
    }
    bumpImmersiveChrome();
    return () => clearImmersiveChromeTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enter immersive only
  }, [immersive]);

  function onMediaEnter() {
    if (!previewEnabled || selectionLocked || isImmersiveBlocked(path) || immersive) return;
    setHovering(true);
    clearHoverTimers();
    const playDelay = linuxMediaGuards
      ? LINUX_HOVER_PLAY_DELAY_MS
      : HOVER_PLAY_DELAY_MS;
    const pinDelay = linuxMediaGuards
      ? LINUX_HOVER_PIN_DELAY_MS
      : HOVER_PIN_DELAY_MS;
    hoverTimerRef.current = window.setTimeout(() => {
      if (selectionLocked || isImmersiveBlocked(path)) return;
      setWantPreview(true);
      onActivate();
    }, playDelay);
    // Sustained hover ≈ play click: keep playing after mouse leave.
    pinTimerRef.current = window.setTimeout(() => {
      if (selectionLocked || isImmersiveBlocked(path)) return;
      setWantPreview(true);
      setPinned(true);
      onActivate();
    }, pinDelay);
  }

  function onMediaLeave() {
    setHovering(false);
    setShowVolume(false);
    clearHoverTimers();
    if (pinned || immersive) return;
    setWantPreview(false);
    setPlaying(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      markLinuxUserSeek();
      try {
        v.currentTime = 0;
      } catch {
        /* ignore */
      }
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
    markLinuxUserSeek();
    video.currentTime = ratio * duration;
    setCurrent(video.currentTime);
  }

  function exitExpanded() {
    const t = immersiveVideoRef.current?.currentTime ?? current;
    const wasPlaying = immersiveVideoRef.current
      ? !immersiveVideoRef.current.paused
      : playing;
    setImmersive(false);
    releaseImmersive(path);
    setPinned(true);
    setWantPreview(true);
    onActivate();
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

  function toggleFullscreen(e: SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
    setPinned(true);
    setWantPreview(true);
    onActivate();

    if (immersive) {
      exitExpanded();
      return;
    }
    // Always use portaled overlay — Fullscreen API fails hit-testing inside Radix dialogs.
    setImmersive(true);
  }

  const playhead = duration > 0 ? current / duration : 0;

  function renderTileTransportControls() {
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
              "pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/70",
              !showControls && "pointer-events-none",
            )}
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
            onPointerDown={(ev) => ev.stopPropagation()}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
          </button>
        </div>

        <div
          data-controls
          className={cn(
            "absolute top-1 right-1 z-20 flex items-center gap-0.5 transition-opacity [transform:translateZ(1px)]",
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
                className="mr-1 h-1 w-14 cursor-pointer accent-white"
                onChange={(ev) => {
                  const next = Number(ev.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
              />
            )}
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded bg-black/55 text-white hover:bg-black/70"
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
            onClick={(ev) => toggleFullscreen(ev)}
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>

        <div
          data-controls
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 transition-opacity [transform:translateZ(1px)]",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          {showControls && duration > 0 && (
            <div className="px-1.5 pb-0.5 text-right font-mono text-[9px] text-white/90 drop-shadow">
              {formatClock(current)} / {formatClock(duration)}
            </div>
          )}
          <div
            ref={barRef}
            className="relative h-3 cursor-pointer bg-black/40 px-1"
            onPointerDown={(ev) => {
              ev.stopPropagation();
              draggingRef.current = true;
              setDragging(true);
              setPinned(true);
              setWantPreview(true);
              onActivate();
              markLinuxUserSeek();
              (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
              seekFromClientX(ev.clientX, barRef.current, videoRef.current);
            }}
            onPointerMove={(ev) => {
              if (!dragging) return;
              seekFromClientX(ev.clientX, barRef.current, videoRef.current);
            }}
            onPointerUp={() => {
              draggingRef.current = false;
              markLinuxUserSeek();
              setDragging(false);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
              markLinuxUserSeek();
              setDragging(false);
            }}
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

  const immersiveChromeVisible = immersiveChrome || dragging;

  return (
    <div
      data-tile
      data-thumb-path={path}
      ref={tileRef}
      className={cn(
        // border-2 always — avoids 1px→2px layout jump on select
        "relative flex flex-col overflow-hidden rounded-md border-2 text-left transition-colors",
        selected
          ? "border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
          : "border-border/70",
        // Ring only when pinned (not mere hover-preview) — no flash on play start
        pinned && isActive && !selected && "ring-2 ring-primary/50",
      )}
    >
      <div
        className="relative isolate flex aspect-video items-center justify-center overflow-hidden bg-black/90"
        onMouseEnter={onMediaEnter}
        onMouseLeave={onMediaLeave}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-controls]")) return;
          if (immersive || isImmersiveBlocked(path)) return;
          onSelect({ shiftKey: e.shiftKey });
        }}
      >
        <div
          data-controls
          data-no-marquee=""
          className="absolute top-1.5 left-1.5 z-10 [transform:translateZ(1px)]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onPointerDown={(e) => {
              if (!e.shiftKey) return;
              e.preventDefault();
              e.stopPropagation();
              shiftCheckboxRef.current = true;
              onSelect({ shiftKey: true });
            }}
            onCheckedChange={() => {
              if (shiftCheckboxRef.current) {
                shiftCheckboxRef.current = false;
                return;
              }
              onSelect({ shiftKey: false });
            }}
            aria-label={`${filename} auswählen`}
            className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
          />
        </div>

        {alreadyProcessed ? (
          <span
            className="pointer-events-none absolute top-1.5 right-1.5 z-10 rounded-md border border-amber-400/80 bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-950 shadow-md shadow-black/35"
            aria-label="Bereits bekannt"
          >
            Bekannt
          </span>
        ) : showNewBadge ? (
          <span
            className="pointer-events-none absolute top-1.5 right-1.5 z-10 rounded-md border border-sky-300/90 bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-950 shadow-md shadow-black/35"
            aria-label="Neu"
          >
            Neu
          </span>
        ) : null}

        {/* Poster stays mounted under the video to avoid swap/layout jitter. */}
        {thumbUrl && !immersive ? (
          <img
            src={thumbUrl}
            alt=""
            className={cn(
              "absolute inset-0 z-0 h-full w-full object-cover transition-[filter,transform] duration-300",
              thumbQuality === "lq" &&
                !(showVideo && src) &&
                "scale-[1.03] blur-[0.6px]",
            )}
            draggable={false}
          />
        ) : !immersive && !(showVideo && src) ? (
          <div className="absolute inset-0 z-0 flex h-full w-full items-center justify-center bg-gradient-to-br from-muted/50 to-black/40">
            <div className="absolute inset-0 animate-pulse bg-muted/30" />
            <Film className="relative h-8 w-8 text-muted" />
          </div>
        ) : immersive ? (
          <div className="absolute inset-0 z-0 flex h-full w-full items-center justify-center bg-black/80">
            <Film className="h-8 w-8 text-white/40" />
          </div>
        ) : null}

        {showVideo && src && !loadError && !immersive ? (
          <video
            key={src}
            ref={videoRef}
            className="absolute inset-0 z-[1] h-full w-full object-cover"
            src={src}
            playsInline
            muted={muted}
            preload={linuxMediaGuards ? "none" : "metadata"}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onSeeking={() => markLinuxUserSeek()}
            onEnded={(e) => {
              if (!shouldAcceptEnded(e.currentTarget)) return;
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
        ) : null}

        {loadError && !immersive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/50 px-2 text-center text-[10px] text-white/90 [transform:translateZ(1px)]">
            Keine Vorschau (Codec/WebView)
          </div>
        )}

        {!immersive && renderTileTransportControls()}
      </div>

      <button
        type="button"
        data-marquee-ok=""
        className="truncate px-2 py-1 text-left text-[11px] hover:bg-black/5"
        onClick={(e) => onSelect({ shiftKey: e.shiftKey })}
        title={filename}
      >
        {filename}
      </button>
      <button
        type="button"
        data-marquee-ok=""
        className="flex w-full items-baseline justify-between gap-2 px-2 pb-1 text-left text-[10px] text-muted hover:bg-black/5"
        onClick={(e) => onSelect({ shiftKey: e.shiftKey })}
      >
        <span className="min-w-0 truncate">
          {sizeLabel}
        </span>
        {captureLabel ? (
          <span className="shrink-0 tabular-nums">{captureLabel}</span>
        ) : null}
      </button>

      {immersive &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-auto fixed inset-0 z-[9999] bg-black"
            role="dialog"
            aria-modal="true"
            aria-label={`${filename} Vollbild`}
            data-sd-immersive-overlay=""
            onPointerDown={(e) => {
              e.stopPropagation();
              lastPointerTypeRef.current = e.pointerType;
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onMouseMove={() => bumpImmersiveChrome()}
          >
            <div className="relative flex h-full w-full items-center justify-center">
              {src && !loadError ? (
                <video
                  ref={immersiveVideoRef}
                  className="pointer-events-none max-h-full max-w-full object-contain"
                  src={src}
                  playsInline
                  muted={muted}
                  preload="auto"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onSeeking={() => markLinuxUserSeek()}
                  onEnded={(e) => {
                    if (!shouldAcceptEnded(e.currentTarget)) return;
                    setPlaying(false);
                    bumpImmersiveChrome();
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

              {/* Center play/pause — same pattern as VideoPlayer */}
              <button
                type="button"
                className="group/play absolute inset-0 z-[1] flex cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
                onClick={(ev) => {
                  togglePlay(ev);
                  if (lastPointerTypeRef.current === "touch") {
                    bumpImmersiveChrome(IMMERSIVE_TOUCH_CHROME_MS);
                  } else {
                    bumpImmersiveChrome();
                  }
                }}
                aria-label={playing ? "Pause" : "Play"}
              >
                <span
                  className={cn(
                    "pointer-events-none flex h-16 w-16 items-center justify-center rounded-full bg-black/50 text-white shadow-md transition-all duration-200",
                    immersiveChromeVisible
                      ? "scale-100 opacity-100"
                      : "scale-95 opacity-0 group-focus-visible/play:scale-100 group-focus-visible/play:opacity-100",
                  )}
                  aria-hidden
                >
                  {playing ? (
                    <Pause className="h-10 w-10" />
                  ) : (
                    <Play className="ml-0.5 h-10 w-10" />
                  )}
                </span>
              </button>

              {/* Bottom chrome */}
              <div
                data-controls
                className={cn(
                  "absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-5 pt-16 pb-5 transition-opacity duration-200",
                  immersiveChromeVisible
                    ? "opacity-100"
                    : "pointer-events-none opacity-0",
                )}
                onClick={(ev) => ev.stopPropagation()}
                onPointerDown={(ev) => ev.stopPropagation()}
                onMouseMove={(ev) => {
                  ev.stopPropagation();
                  bumpImmersiveChrome();
                }}
              >
                <div
                  ref={immersiveBarRef}
                  className="group/scrub relative mb-3 h-5 cursor-pointer"
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    draggingRef.current = true;
                    setDragging(true);
                    clearImmersiveChromeTimer();
                    setImmersiveChrome(true);
                    markLinuxUserSeek();
                    (ev.currentTarget as HTMLElement).setPointerCapture?.(
                      ev.pointerId,
                    );
                    seekFromClientX(
                      ev.clientX,
                      immersiveBarRef.current,
                      immersiveVideoRef.current,
                    );
                  }}
                  onPointerMove={(ev) => {
                    if (!dragging) return;
                    seekFromClientX(
                      ev.clientX,
                      immersiveBarRef.current,
                      immersiveVideoRef.current,
                    );
                  }}
                  onPointerUp={() => {
                    draggingRef.current = false;
                    markLinuxUserSeek();
                    setDragging(false);
                    bumpImmersiveChrome();
                  }}
                  onPointerCancel={() => {
                    draggingRef.current = false;
                    markLinuxUserSeek();
                    setDragging(false);
                    bumpImmersiveChrome();
                  }}
                >
                  <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25 transition-[height] group-hover/scrub:h-1.5" />
                  <div
                    className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-white transition-[height] group-hover/scrub:h-1.5"
                    style={{ width: `${playhead * 100}%` }}
                  />
                  <div
                    className={cn(
                      "absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform",
                      "scale-90 group-hover/scrub:scale-100",
                      dragging && "scale-110",
                    )}
                    style={{ left: `${playhead * 100}%` }}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <span className="min-w-[5.5rem] font-mono text-xs tabular-nums text-white/90">
                    {formatClock(current)} / {formatClock(duration)}
                  </span>

                  <div className="min-w-0 flex-1 truncate text-sm text-white/70">
                    {filename}
                    <span className="ml-2 text-xs text-white/40">
                      Esc zum Beenden
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-1"
                    onMouseEnter={() => {
                      setShowVolume(true);
                      clearImmersiveChromeTimer();
                      setImmersiveChrome(true);
                    }}
                    onMouseLeave={() => {
                      setShowVolume(false);
                      bumpImmersiveChrome();
                    }}
                  >
                    <div
                      className={cn(
                        "overflow-hidden transition-all duration-200",
                        showVolume ? "w-24 opacity-100" : "w-0 opacity-0",
                      )}
                    >
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={muted ? 0 : volume}
                        aria-label="Lautstärke"
                        className="h-1 w-24 cursor-pointer accent-white"
                        onChange={(ev) => {
                          const next = Number(ev.target.value);
                          setVolume(next);
                          setMuted(next === 0);
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
                      aria-label={muted || volume === 0 ? "Ton an" : "Stumm"}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (muted || volume === 0) {
                          setMuted(false);
                          if (volume === 0) setVolume(0.7);
                        } else {
                          setMuted(true);
                        }
                        bumpImmersiveChrome();
                      }}
                    >
                      {muted || volume === 0 ? (
                        <VolumeX className="h-5 w-5" />
                      ) : (
                        <Volume2 className="h-5 w-5" />
                      )}
                    </button>
                  </div>

                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
                    aria-label="Vollbild beenden"
                    onClick={(ev) => toggleFullscreen(ev)}
                  >
                    <Minimize className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
