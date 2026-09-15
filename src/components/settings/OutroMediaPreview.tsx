/** Compact Outro preview: SD-style thumbnail + hover/play for videos, still for photos. */

import {
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Pause, Play, Volume2, VolumeX, ZoomIn } from "lucide-react";
import { SdTilePreview } from "@/components/SdTilePreview";
import { useSdThumb } from "@/hooks/useSdThumb";
import { videoFileSrc } from "@/lib/mediaUrl";
import type { ThumbQuality } from "@/lib/sdCard";
import { createSdThumbnailLoader } from "@/lib/sdThumbnailLoader";
import { cn } from "@/lib/utils";

const HOVER_PLAY_DELAY_MS = 180;

type Props = {
  path: string;
  kind: "photo" | "video";
  /** When false, show a muted empty tile (missing file). */
  exists: boolean;
  className?: string;
};

function formatClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function OutroMediaPreview({ path, kind, exists, className }: Props) {
  const { t } = useTranslation();
  const loaderRef = useRef(createSdThumbnailLoader());
  const thumb = useSdThumb(loaderRef.current, path);

  useEffect(() => {
    if (kind !== "video") return;
    const loader = loaderRef.current;
    loader.start();
    if (exists && path) {
      loader.setVisible(path, true, { upgradeToHq: true });
    }
    return () => {
      loader.setVisible(path, false);
      loader.stop();
    };
  }, [path, exists, kind]);

  if (!exists) {
    return (
      <div
        className={cn(
          "overflow-hidden rounded-md border border-destructive/40",
          className,
        )}
      >
        <SdTilePreview placeholder="dark" />
      </div>
    );
  }

  if (kind === "photo") {
    return <OutroPhotoPreview path={path} className={className} />;
  }

  return (
    <OutroVideoPreview
      path={path}
      thumbUrl={thumb?.url}
      thumbQuality={thumb?.quality}
      className={className}
      playLabel={t("common.actions.play")}
      pauseLabel={t("common.actions.pause")}
      volumeLabel={t("video.player.volumeAria")}
      codecErrorLabel={t("sd.tile.noPreviewCodec")}
    />
  );
}

/** Full-resolution still via media server (not the LQ/HQ SD thumb pipeline). */
function OutroPhotoPreview({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    setEnlarged(false);
    void videoFileSrc(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  const canEnlarge = Boolean(src && !failed);

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-md border border-border/70",
          className,
        )}
      >
        <button
          type="button"
          className="relative aspect-video w-full cursor-zoom-in bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          disabled={!canEnlarge}
          aria-label={t("common.actions.fullscreen")}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onClick={() => {
            if (canEnlarge) setEnlarged(true);
          }}
        >
          {src && !failed ? (
            <img
              src={src}
              alt=""
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
              decoding="async"
              onError={() => setFailed(true)}
            />
          ) : (
            <SdTilePreview
              placeholder={failed ? "dark" : "pulse"}
              layout="inline"
            />
          )}
          {canEnlarge ? (
            <span
              className={cn(
                "pointer-events-none absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white transition-opacity",
                hovering ? "opacity-100" : "opacity-0",
              )}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </button>
      </div>

      {enlarged &&
        src &&
        typeof document !== "undefined" &&
        createPortal(
          <button
            type="button"
            className="pointer-events-auto fixed inset-0 z-[9999] flex cursor-zoom-out items-center justify-center bg-black/95 p-4 focus-visible:outline-none"
            role="dialog"
            aria-modal="true"
            aria-label={t("common.actions.close")}
            onClick={() => setEnlarged(false)}
          >
            <img
              src={src}
              alt=""
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </button>,
          document.body,
        )}
    </>
  );
}

function OutroVideoPreview({
  path,
  thumbUrl,
  thumbQuality,
  className,
  playLabel,
  pauseLabel,
  volumeLabel,
  codecErrorLabel,
}: {
  path: string;
  thumbUrl?: string;
  thumbQuality?: ThumbQuality;
  className?: string;
  playLabel: string;
  pauseLabel: string;
  volumeLabel: string;
  codecErrorLabel: string;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const immersiveVideoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [wantPreview, setWantPreview] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [showVolume, setShowVolume] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [hoverChrome, setHoverChrome] = useState(false);

  const showVideo = wantPreview || pinned || enlarged;
  const showControls = hovering || hoverChrome || (pinned && !playing) || enlarged;
  const playhead = duration > 0 ? current / duration : 0;

  useEffect(() => {
    setSrc(null);
    setWantPreview(false);
    setPinned(false);
    setPlaying(false);
    setMuted(true);
    setLoadError(false);
    setDuration(0);
    setCurrent(0);
    setEnlarged(false);
  }, [path]);

  useEffect(() => {
    if (!showVideo || src) return;
    let cancelled = false;
    void videoFileSrc(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showVideo, src, path]);

  // Autoplay only when hover-preview becomes active — never restart on pin/pause/leave.
  useEffect(() => {
    const v = enlarged ? immersiveVideoRef.current : videoRef.current;
    if (!v || !src) return;
    if (!(wantPreview || enlarged)) return;
    void v.play().catch(() => undefined);
  }, [src, wantPreview, enlarged]);

  // Sync into enlarged player on enter.
  useEffect(() => {
    if (!enlarged || !src) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enter enlarge only
  }, [enlarged, src]);

  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitEnlarged();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enlarged]);

  useEffect(() => {
    const apply = (v: HTMLVideoElement | null) => {
      if (!v) return;
      v.muted = muted;
      v.volume = volume;
    };
    apply(videoRef.current);
    apply(immersiveVideoRef.current);
  }, [muted, volume, src, enlarged]);

  function clearHoverTimer() {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  function onMediaEnter() {
    if (enlarged) return;
    setHovering(true);
    setHoverChrome(true);
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      setWantPreview(true);
    }, HOVER_PLAY_DELAY_MS);
  }

  function onMediaLeave() {
    setHovering(false);
    setHoverChrome(false);
    setShowVolume(false);
    clearHoverTimer();
    if (pinned || enlarged) return;
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
  }

  function togglePlay(e: SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
    const v = enlarged ? immersiveVideoRef.current : videoRef.current;
    if (!v && !src) {
      setPinned(true);
      setWantPreview(true);
      return;
    }
    if (!v) return;
    if (v.paused) {
      setPinned(true);
      setWantPreview(true);
      void v.play().catch(() => undefined);
    } else {
      v.pause();
      setPinned(true);
    }
  }

  function exitEnlarged() {
    const full = immersiveVideoRef.current;
    const t = full?.currentTime ?? current;
    const wasPlaying = full ? !full.paused : playing;
    setEnlarged(false);
    setPinned(true);
    setWantPreview(true);
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

  function openEnlarged(e: SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
    setWantPreview(true);
    setPinned(true);
    setEnlarged(true);
  }

  function seekTo(clientX: number, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const t = ratio * duration;
    setCurrent(t);
    const v = enlarged ? immersiveVideoRef.current : videoRef.current;
    if (!v) return;
    try {
      v.currentTime = t;
    } catch {
      /* ignore */
    }
  }

  function renderTransport(compact: boolean) {
    return (
      <>
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity",
            showControls ? "opacity-100" : "opacity-0",
          )}
        >
          <button
            type="button"
            className={cn(
              "pointer-events-auto flex items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/70",
              compact ? "h-9 w-9" : "h-12 w-12",
              !showControls && "pointer-events-none",
            )}
            aria-label={playing ? pauseLabel : playLabel}
            onClick={togglePlay}
            onPointerDown={(ev) => ev.stopPropagation()}
          >
            {playing ? (
              <Pause className={compact ? "h-4 w-4" : "h-6 w-6"} />
            ) : (
              <Play
                className={cn(
                  "fill-current",
                  compact ? "h-4 w-4" : "h-6 w-6",
                )}
              />
            )}
          </button>
        </div>

        <div
          className={cn(
            "absolute top-1 right-1 z-20 flex items-center gap-0.5 transition-opacity",
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
            {showVolume ? (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label={volumeLabel}
                className="mr-1 h-1 w-14 cursor-pointer accent-white"
                onChange={(ev) => {
                  const next = Number(ev.target.value);
                  setVolume(next);
                  setMuted(next <= 0);
                }}
              />
            ) : null}
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
              aria-label={volumeLabel}
              onClick={() => setMuted((m) => !m)}
            >
              {muted || volume <= 0 ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          {!enlarged ? (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
              aria-label={t("common.actions.fullscreen")}
              onClick={openEnlarged}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-4 pb-1 transition-opacity",
            showControls || playing
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
          onClick={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          <div
            className="relative h-1.5 cursor-pointer rounded-full bg-white/30"
            onPointerDown={(ev) => {
              ev.currentTarget.setPointerCapture(ev.pointerId);
              setDragging(true);
              seekTo(ev.clientX, ev.currentTarget);
            }}
            onPointerMove={(ev) => {
              if (!dragging) return;
              seekTo(ev.clientX, ev.currentTarget);
            }}
            onPointerUp={(ev) => {
              setDragging(false);
              try {
                ev.currentTarget.releasePointerCapture(ev.pointerId);
              } catch {
                /* ignore */
              }
            }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white"
              style={{ width: `${playhead * 100}%` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-white/90">
            <span>{formatClock(current)}</span>
            <span>{formatClock(duration)}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-md border border-border/70",
          className,
        )}
      >
        <SdTilePreview
          thumbUrl={!enlarged ? thumbUrl : undefined}
          thumbQuality={thumbQuality}
          suppressLqEnhance={showVideo && !!src}
          placeholder={
            enlarged ? "dark" : showVideo && src ? "none" : "video-icon"
          }
          onMouseEnter={onMediaEnter}
          onMouseLeave={onMediaLeave}
        >
          {showVideo && src && !loadError && !enlarged ? (
            <video
              key={src}
              ref={videoRef}
              className="absolute inset-0 z-[1] h-full w-full object-cover"
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

          {loadError && !enlarged ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/50 px-2 text-center text-[10px] text-white/90">
              {codecErrorLabel}
            </div>
          ) : null}

          {!enlarged ? renderTransport(true) : null}
        </SdTilePreview>
      </div>

      {enlarged &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-auto fixed inset-0 z-[9999] flex cursor-zoom-out items-center justify-center bg-black/95 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={t("common.actions.close")}
            onClick={exitEnlarged}
            onMouseMove={() => setHoverChrome(true)}
          >
            <div
              className="relative flex max-h-full max-w-full items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {src && !loadError ? (
                <video
                  ref={immersiveVideoRef}
                  className="max-h-[90vh] max-w-[90vw] object-contain"
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
              ) : null}
              <div className="absolute inset-0">{renderTransport(false)}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
