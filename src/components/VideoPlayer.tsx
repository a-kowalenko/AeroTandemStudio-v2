import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { Button } from "./ui/button";
import { videoFileSrc } from "../lib/mediaUrl";
import { getMediaThumbnail } from "../lib/sdCard";
import { cn, isLinuxHost } from "../lib/utils";
import {
  previewRotateMediaStyle,
  previewRotateStageClass,
} from "../lib/mediaPreviewRotate";

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

export type VideoChrome = "auto" | "trim" | "playback";

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
  /** UI chrome: trim = filmstrip + caps; playback = overlay scrub + transport. */
  chrome?: VideoChrome;
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
  /** Filmstrip frame data URLs for Apple-style trim timeline (optional). */
  filmstripFrames?: string[];
  /** Optional CSS preview rotation (degrees clockwise) for edit dialogs. */
  previewRotateDeg?: number | null;
  /**
   * Animate CSS rotate preview. Disable when entering/leaving rotate layout so
   * `translate(-50%, -50%)` is not interpolated (avoids corner slide-in).
   */
  previewRotateTransition?: boolean;
  /**
   * Fill parent height: video stage flex-shrinks, timeline stays visible.
   * Use inside constrained edit shells (avoids aspect-video clipping the scrubber).
   */
  fillAvailable?: boolean;
  /** Emphasize playhead / draw a vertical “cut here” guide (split mode). */
  emphasizePlayhead?: boolean;
  /** Optional seek snap (e.g. nearest keyframe in split mode). */
  snapSeekMs?: (ms: number) => number;
  disabled?: boolean;
};

/** Precise clock for trim / scrub bubbles. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--.-";
  const totalSec = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const frac = `.${tenths}`;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}${frac}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}${frac}`;
}

/** Transport clock — whole seconds only. */
function formatClockMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function bufferedEndRatio(video: HTMLVideoElement, durationMs: number): number {
  if (!durationMs || !Number.isFinite(durationMs) || video.buffered.length === 0) {
    return 0;
  }
  try {
    let end = 0;
    for (let i = 0; i < video.buffered.length; i += 1) {
      end = Math.max(end, video.buffered.end(i));
    }
    return Math.min(1, (end * 1000) / durationMs);
  } catch {
    return 0;
  }
}

const HANDLE_HIT_PX = 20;
const MIN_RANGE_MS = 100;
/** Linux/WebKitGTK only: GStreamer often fires `ended` during/after seek. */
const LINUX_SEEK_ENDED_GUARD_MS = 450;
const LINUX_ENDED_NEAR_END_SEC = 0.4;
/** Brief center overlay after touch tap (no persistent hover on touch). */
const TOUCH_OVERLAY_MS = 1400;
/** Auto-hide bottom chrome while playing (desktop). */
const CONTROLS_HIDE_MS = 2400;
/** Brief center play/pause flash. */
const CENTER_CUE_MS = 520;
const SEEK_STEP_MS = 5000;
const DOUBLE_TAP_SKIP_MS = 10_000;
/** WebKit (macOS WKWebView): metadata preload often paints no frame until a tiny seek. */
const WEBKIT_FIRST_FRAME_SEEK_SEC = 0.001;
/** iOS Photos–like trim handle yellow */
const TRIM_CAP = "#FFD60A";
const TRIM_CAP_ACTIVE = "#FFE566";
const TRIM_BORDER = "#FFD60A";
/** Visual cap width (px); half is reserved as side gutter so 0%/100% caps aren’t clipped. */
const TRIM_CAP_W = 14;
const TRIM_CAP_GUTTER = TRIM_CAP_W / 2;

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
      chrome = "auto",
      keepRange,
      onTrimChange,
      onTrimCommit,
      keyframeMarks,
      filmstripFrames,
      previewRotateDeg = null,
      previewRotateTransition = true,
      fillAvailable = false,
      emphasizePlayhead = false,
      snapSeekMs,
      disabled,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const scrubBarRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [volume, setVolume] = useState(0.7);
    const [muted, setMuted] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [dragHandle, setDragHandle] = useState<TrimHandle | null>(null);
    const [src, setSrc] = useState<string | null>(null);
    const [posterUrl, setPosterUrl] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Center play/pause cue — hover (desktop) or brief flash after touch tap. */
    const [overlayVisible, setOverlayVisible] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [stageHovered, setStageHovered] = useState(false);
    const [volumeHovered, setVolumeHovered] = useState(false);
    const [bufferedRatio, setBufferedRatio] = useState(0);
    const [scrubHoverRatio, setScrubHoverRatio] = useState<number | null>(null);
    const [centerCue, setCenterCue] = useState<"play" | "pause" | null>(null);
    const dragModeRef = useRef<"seek" | TrimHandle | null>(null);
    const overlayHideTimerRef = useRef<number | null>(null);
    const controlsHideTimerRef = useRef<number | null>(null);
    const centerCueTimerRef = useRef<number | null>(null);
    const wasPlayingBeforeScrubRef = useRef(false);
    const lastPointerTypeRef = useRef<string>("mouse");
    /** Linux-only: suppress spurious `ended` while/after scrubbing. */
    const linuxMediaGuards = useRef(isLinuxHost()).current;
    const draggingRef = useRef(false);
    const ignoreEndedUntilRef = useRef(0);
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
    const snapSeekMsRef = useRef(snapSeekMs);
    snapSeekMsRef.current = snapSeekMs;

    function applySeekSnap(ms: number): number {
      const snap = snapSeekMsRef.current;
      if (!snap) return ms;
      const next = snap(ms);
      return Number.isFinite(next) ? next : ms;
    }

    function markLinuxUserSeek() {
      if (!linuxMediaGuards) return;
      ignoreEndedUntilRef.current =
        performance.now() + LINUX_SEEK_ENDED_GUARD_MS;
    }

    function shouldAcceptEnded(v: HTMLVideoElement): boolean {
      if (!linuxMediaGuards) return true;
      if (draggingRef.current || dragModeRef.current) return false;
      if (performance.now() < ignoreEndedUntilRef.current) return false;
      if (v.seeking) return false;
      const dur = v.duration;
      if (!Number.isFinite(dur) || dur <= 0) return false;
      return v.currentTime >= dur - LINUX_ENDED_NEAR_END_SEC;
    }

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
        const snapped = applySeekSnap(Math.max(0, ms));
        markLinuxUserSeek();
        v.currentTime = snapped / 1000;
        setCurrentMs(snapped);
      },
      pause: () => {
        videoRef.current?.pause();
      },
      play: () => {
        void videoRef.current?.play();
      },
    }));

    function clearControlsHideTimer() {
      if (controlsHideTimerRef.current != null) {
        window.clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
    }

    function clearCenterCueTimer() {
      if (centerCueTimerRef.current != null) {
        window.clearTimeout(centerCueTimerRef.current);
        centerCueTimerRef.current = null;
      }
    }

    function flashCenterCue(kind: "play" | "pause") {
      clearCenterCueTimer();
      setCenterCue(kind);
      centerCueTimerRef.current = window.setTimeout(() => {
        setCenterCue(null);
        centerCueTimerRef.current = null;
      }, CENTER_CUE_MS);
    }

    function bumpControlsVisibility() {
      clearControlsHideTimer();
      setControlsVisible(true);
      if (
        playing &&
        !stageHovered &&
        !volumeHovered &&
        !draggingRef.current
      ) {
        controlsHideTimerRef.current = window.setTimeout(() => {
          setControlsVisible(false);
          controlsHideTimerRef.current = null;
        }, CONTROLS_HIDE_MS);
      }
    }

    useEffect(() => {
      setPlaying(false);
      setCurrentMs(0);
      setDurationMs(0);
      setSrc(null);
      setPosterUrl(null);
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
      // FFmpeg first-frame poster (cached) — fills black WKWebView until decode paints.
      void getMediaThumbnail(srcPath, "preview")
        .then((r) => {
          if (!cancelled) setPosterUrl(r.data_url);
        })
        .catch(() => {
          if (!cancelled) setPosterUrl(null);
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

    function clearOverlayHideTimer() {
      if (overlayHideTimerRef.current != null) {
        window.clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = null;
      }
    }

    function showOverlayTemporarily() {
      clearOverlayHideTimer();
      setOverlayVisible(true);
      overlayHideTimerRef.current = window.setTimeout(() => {
        setOverlayVisible(false);
        overlayHideTimerRef.current = null;
      }, TOUCH_OVERLAY_MS);
    }

    useEffect(() => () => {
      clearOverlayHideTimer();
      clearControlsHideTimer();
      clearCenterCueTimer();
    }, []);

    useEffect(() => {
      if (disabled || !src || loadError) {
        clearOverlayHideTimer();
        setOverlayVisible(false);
      }
    }, [disabled, src, loadError]);

    useEffect(() => {
      bumpControlsVisibility();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- visibility driven by play/hover
    }, [playing, stageHovered, volumeHovered, dragging]);

    function togglePlay() {
      const v = videoRef.current;
      if (!v || disabled) return;
      if (v.paused) {
        flashCenterCue("play");
        void v.play();
      } else {
        flashCenterCue("pause");
        v.pause();
      }
      bumpControlsVisibility();
    }

    function seekBy(deltaMs: number) {
      const v = videoRef.current;
      const dur = durationMsRef.current;
      if (!v || !dur) return;
      const next = applySeekSnap(
        Math.max(0, Math.min(dur, v.currentTime * 1000 + deltaMs)),
      );
      markLinuxUserSeek();
      v.currentTime = next / 1000;
      emitTime(next, dur);
      bumpControlsVisibility();
    }

    const canTogglePlayback = Boolean(src && !disabled && !loadError);

    function msFromClientX(
      clientX: number,
      barEl?: HTMLDivElement | null,
    ): number | null {
      const bar = barEl ?? scrubBarRef.current ?? barRef.current;
      const dur = durationMsRef.current;
      if (!bar || !dur) return null;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * dur;
    }

    function ratioFromClientX(
      clientX: number,
      barEl?: HTMLDivElement | null,
    ): number | null {
      const bar = barEl ?? scrubBarRef.current ?? barRef.current;
      if (!bar) return null;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function seekFromClientX(
      clientX: number,
      barEl?: HTMLDivElement | null,
    ) {
      const v = videoRef.current;
      const ms = msFromClientX(clientX, barEl);
      if (ms == null || !v) return;
      const snapped = applySeekSnap(ms);
      markLinuxUserSeek();
      v.currentTime = snapped / 1000;
      emitTime(snapped, durationMsRef.current);
      bumpControlsVisibility();
    }

    function applyTrimDrag(handle: TrimHandle, clientX: number) {
      const ms = msFromClientX(clientX, barRef.current);
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
      markLinuxUserSeek();
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
    const resolvedChrome: Exclude<VideoChrome, "auto"> =
      chrome === "auto" ? (trimEditable ? "trim" : "playback") : chrome;
    const isTrimChrome = resolvedChrome === "trim";
    const isPlaybackChrome = resolvedChrome === "playback";
    const showSplitFilmstrip =
      isPlaybackChrome &&
      emphasizePlayhead &&
      Boolean(filmstripFrames && filmstripFrames.length > 0);
    /** Trim + split: filmstrip below, no in-player scrub/transport. */
    const minimalStageChrome = isTrimChrome || emphasizePlayhead;
    const showOverlayTransport = isPlaybackChrome && !emphasizePlayhead;
    const showTimelineSlot = isTrimChrome || showSplitFilmstrip;
    const timelineInteractive =
      (isTrimChrome && trimEditable) || showSplitFilmstrip;
    const startMsForBubble = keepStart * durationMs;
    const endMsForBubble = keepEnd * durationMs;
    const rotateLayout = previewRotateMediaStyle(previewRotateDeg);
    // Only transition while rotate layout stays active; null↔layout must not
    // interpolate translate(-50%, -50%) or the video slides in from a corner.
    const rotateMediaStyle = rotateLayout
      ? {
          ...rotateLayout,
          transition:
            previewRotateTransition && previewRotateDeg != null
              ? "transform 200ms ease"
              : "none",
        }
      : undefined;
    const rotateStageDeg = previewRotateDeg ?? 0;
    const showChromeControls =
      controlsVisible ||
      !playing ||
      stageHovered ||
      volumeHovered ||
      dragging;
    const scrubBubbleRatio =
      scrubHoverRatio ?? (dragging && dragHandle == null ? playhead : null);
    const scrubBubbleMs =
      scrubBubbleRatio != null && durationMs > 0
        ? scrubBubbleRatio * durationMs
        : null;

    function renderVolumeControl() {
      return (
        <div
          className="group/vol relative flex items-center"
          onMouseEnter={() => setVolumeHovered(true)}
          onMouseLeave={() => setVolumeHovered(false)}
        >
          <button
            type="button"
            disabled={disabled}
            className="rounded p-0.5 text-white hover:bg-white/15 disabled:opacity-50"
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
          <div
            className={cn(
              "overflow-hidden transition-all duration-200",
              volumeHovered ? "w-24 opacity-100" : "w-0 opacity-0",
            )}
          >
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
              className="ml-1 w-20 accent-white"
              aria-label={t("video.player.volumeAria")}
            />
          </div>
        </div>
      );
    }

    function beginTimelinePointer(
      e: ReactPointerEvent<HTMLDivElement>,
      opts: { trim: boolean },
    ) {
      if (disabled) return;
      const bar = e.currentTarget;
      lastPointerTypeRef.current = e.pointerType;
      wasPlayingBeforeScrubRef.current = playing;
      const mode = opts.trim ? hitTestHandle(e.clientX) : "seek";
      dragModeRef.current = mode;
      draggingRef.current = true;
      setDragging(true);
      setDragHandle(mode === "seek" ? null : mode);
      markLinuxUserSeek();
      bar.setPointerCapture?.(e.pointerId);
      const r = ratioFromClientX(e.clientX, bar);
      if (r != null) setScrubHoverRatio(r);
      if (mode === "seek") {
        videoRef.current?.pause();
        seekFromClientX(e.clientX, bar);
      } else {
        applyTrimDrag(mode, e.clientX);
      }
      bumpControlsVisibility();
    }

    function moveTimelinePointer(e: ReactPointerEvent<HTMLDivElement>) {
      const bar = e.currentTarget;
      const r = ratioFromClientX(e.clientX, bar);
      if (r != null) setScrubHoverRatio(r);
      if (!dragging || !dragModeRef.current) return;
      if (dragModeRef.current === "seek") seekFromClientX(e.clientX, bar);
      else applyTrimDrag(dragModeRef.current, e.clientX);
    }

    function endTimelinePointer(e: ReactPointerEvent<HTMLDivElement>) {
      const mode = dragModeRef.current;
      if (mode === "start" || mode === "end") {
        const ms = msFromClientX(e.clientX, barRef.current);
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
      draggingRef.current = false;
      markLinuxUserSeek();
      setDragging(false);
      setDragHandle(null);
      if (wasPlayingBeforeScrubRef.current && mode === "seek") {
        void videoRef.current?.play();
      }
      wasPlayingBeforeScrubRef.current = false;
      bumpControlsVisibility();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    return (
      <div
        ref={rootRef}
        tabIndex={0}
        className={cn(
          "flex flex-col gap-2 outline-none",
          fillAvailable && "h-full min-h-0",
          className,
        )}
        onKeyDown={(e) => {
          if (!canTogglePlayback) return;
          const tag = (e.target as HTMLElement).tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          if (e.key === " " || e.code === "Space") {
            e.preventDefault();
            togglePlay();
            return;
          }
          if (e.key === "j" || e.key === "J" || e.key === "ArrowLeft") {
            e.preventDefault();
            seekBy(-SEEK_STEP_MS);
            return;
          }
          if (e.key === "l" || e.key === "L" || e.key === "ArrowRight") {
            e.preventDefault();
            seekBy(SEEK_STEP_MS);
          }
        }}
      >
        <div
          ref={stageRef}
          className={cn(
            "relative overflow-hidden rounded-md bg-black transition-[aspect-ratio] duration-200",
            fillAvailable
              ? "min-h-0 w-full flex-1"
              : previewRotateStageClass(rotateStageDeg),
          )}
          onMouseEnter={() => {
            setStageHovered(true);
            if (!canTogglePlayback) return;
            clearOverlayHideTimer();
            setOverlayVisible(true);
            bumpControlsVisibility();
          }}
          onMouseLeave={() => {
            setStageHovered(false);
            clearOverlayHideTimer();
            setOverlayVisible(false);
            bumpControlsVisibility();
          }}
          onMouseMove={() => {
            bumpControlsVisibility();
          }}
          onClick={() => {
            rootRef.current?.focus();
          }}
          onPointerDown={(e) => {
            lastPointerTypeRef.current = e.pointerType;
          }}
          onDoubleClick={(e) => {
            if (!canTogglePlayback || !durationMs) return;
            const rect = stageRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mid = rect.left + rect.width / 2;
            e.preventDefault();
            seekBy(e.clientX < mid ? -DOUBLE_TAP_SKIP_MS : DOUBLE_TAP_SKIP_MS);
          }}
        >
          {src ? (
            <video
              key={src}
              ref={videoRef}
              className={cn(
                "pointer-events-none object-contain",
                rotateMediaStyle ? null : "h-full w-full",
              )}
              style={rotateMediaStyle}
              src={src}
              poster={posterUrl ?? undefined}
              playsInline
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={(e) => {
                if (!shouldAcceptEnded(e.currentTarget)) return;
                setPlaying(false);
                onEnded?.();
              }}
              onSeeking={() => {
                markLinuxUserSeek();
              }}
              onError={(e) => {
                const code = e.currentTarget.error?.code;
                // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED — typical on Linux without GStreamer codecs
                if (code === 4) {
                  setLoadError(
                    t("video.player.loadErrorLinux"),
                  );
                } else {
                  setLoadError(t("video.player.loadError"));
                }
              }}
              onLoadedMetadata={(e) => {
                setLoadError(null);
                e.currentTarget.muted = mutedRef.current;
                e.currentTarget.volume = mutedRef.current ? 0 : volumeRef.current;
                const d = e.currentTarget.duration * 1000;
                emitTime(0, d);
                setBufferedRatio(bufferedEndRatio(e.currentTarget, d));
                // WKWebView / Safari: metadata alone often leaves a black frame.
                if (!autoPlayRef.current) {
                  try {
                    const v = e.currentTarget;
                    if (v.currentTime === 0) {
                      markLinuxUserSeek();
                      v.currentTime = Math.min(
                        WEBKIT_FIRST_FRAME_SEEK_SEC,
                        Number.isFinite(v.duration) && v.duration > 0
                          ? v.duration * 0.001
                          : WEBKIT_FIRST_FRAME_SEEK_SEC,
                      );
                    }
                  } catch {
                    /* ignore seek failures */
                  }
                }
                if (autoPlayRef.current && !disabled) {
                  void e.currentTarget.play().catch(() => {
                    /* autoplay may be blocked until user gesture */
                  });
                }
              }}
              onProgress={(e) => {
                const v = e.currentTarget;
                const dur = Number.isFinite(v.duration)
                  ? v.duration * 1000
                  : durationMsRef.current;
                setBufferedRatio(bufferedEndRatio(v, dur));
              }}
              onTimeUpdate={(e) => {
                if (dragging) return;
                const v = e.currentTarget;
                emitTime(v.currentTime * 1000, v.duration * 1000);
                setBufferedRatio(
                  bufferedEndRatio(v, v.duration * 1000),
                );
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/70">
              {t("video.player.noVideo")}
            </div>
          )}

          {canTogglePlayback && (
            <button
              type="button"
              className="group/play absolute inset-0 z-[1] flex cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
              onClick={() => {
                togglePlay();
                if (lastPointerTypeRef.current === "touch") {
                  showOverlayTemporarily();
                }
              }}
              aria-label={playing ? "Pause" : "Play"}
            >
              {/* Idle center Play: trim/split = hover only; playback = visible while paused */}
              <span
                className={cn(
                  "pointer-events-none flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white shadow-md transition-all duration-200",
                  !playing &&
                    centerCue == null &&
                    (minimalStageChrome
                      ? overlayVisible
                      : overlayVisible || showChromeControls)
                    ? "scale-100 opacity-100"
                    : "scale-95 opacity-0 group-focus-visible/play:scale-100 group-focus-visible/play:opacity-100",
                )}
                aria-hidden
              >
                <Play className="ml-0.5 h-10 w-10 fill-current" />
              </span>
            </button>
          )}

          {centerCue && canTogglePlayback ? (
            <div className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white shadow-lg">
                {centerCue === "play" ? (
                  <Play className="ml-0.5 h-10 w-10 fill-current" />
                ) : (
                  <Pause className="h-10 w-10 fill-current" />
                )}
              </span>
            </div>
          ) : null}

          {loadError && (
            <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/70 px-4 text-center text-xs text-white/90">
              {loadError}
            </div>
          )}

          {/* Overlay scrub + transport — preview playback only (not trim/split) */}
          {showOverlayTransport && canTogglePlayback ? (
            <div
              className={cn(
                "absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300",
                showChromeControls
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
              <div className="relative space-y-2 px-3 pb-3 pt-8">
                <div
                  ref={scrubBarRef}
                  className="group/scrub relative h-5 cursor-pointer touch-none py-1.5"
                  onPointerDown={(e) => beginTimelinePointer(e, { trim: false })}
                  onPointerMove={moveTimelinePointer}
                  onPointerUp={endTimelinePointer}
                  onPointerCancel={endTimelinePointer}
                  onPointerLeave={() => {
                    if (!dragging) setScrubHoverRatio(null);
                  }}
                  role="slider"
                  aria-valuemin={0}
                  aria-valuemax={durationMs || 0}
                  aria-valuenow={currentMs}
                  aria-label={t("video.player.positionAria")}
                >
                  <div className="relative h-1 rounded-full bg-white/25 transition-[height] group-hover/scrub:h-1.5 group-active/scrub:h-1.5">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white/35"
                      style={{ width: `${bufferedRatio * 100}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white"
                      style={{ width: `${playhead * 100}%` }}
                    />
                    {keyframeMarks?.map((r) => (
                      <div
                        key={`kf-ov-${r}`}
                        className="pointer-events-none absolute inset-y-0 w-px bg-white/40"
                        style={{ left: `${r * 100}%` }}
                      />
                    ))}
                    <div
                      className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover/scrub:opacity-100 group-active/scrub:opacity-100"
                      style={{ left: `${playhead * 100}%` }}
                    />
                  </div>
                  {scrubBubbleMs != null ? (
                    <div
                      className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white opacity-0 transition-opacity group-hover/scrub:opacity-100 group-active/scrub:opacity-100"
                      style={{
                        left: `${(scrubBubbleRatio ?? playhead) * 100}%`,
                      }}
                    >
                      {formatMs(scrubBubbleMs)}
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center gap-3 text-white">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 shrink-0 rounded-full text-white hover:bg-white/15 hover:text-white"
                    disabled={disabled || !src}
                    onClick={togglePlay}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing ? (
                      <Pause className="h-5 w-5 fill-current" />
                    ) : (
                      <Play className="h-5 w-5 translate-x-px fill-current" />
                    )}
                  </Button>
                  <span className="min-w-[5.5rem] text-xs tabular-nums text-white/90">
                    {formatClockMs(currentMs)}
                    <span className="text-white/50"> / </span>
                    {formatClockMs(durationMs)}
                  </span>
                  <div className="ml-auto">{renderVolumeControl()}</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Trim / split filmstrip — fillAvailable always reserves the same height */}
        {showTimelineSlot ? (
          <div
            className={cn(
              "relative shrink-0 overflow-visible",
              fillAvailable
                ? "mt-5"
                : isTrimChrome && trimEditable
                  ? "mt-7"
                  : showSplitFilmstrip
                    ? "mt-7"
                    : null,
            )}
            style={
              isTrimChrome && trimEditable
                ? {
                    paddingLeft: TRIM_CAP_GUTTER,
                    paddingRight: TRIM_CAP_GUTTER,
                  }
                : showSplitFilmstrip
                  ? {
                      /* Room for playhead head so it isn’t clipped at 0%/100%. */
                      paddingLeft: 6,
                      paddingRight: 6,
                    }
                  : undefined
            }
          >
            <div
              ref={timelineInteractive ? barRef : undefined}
              className={cn(
                "relative touch-none select-none overflow-visible",
                fillAvailable
                  ? isTrimChrome && trimEditable
                    ? "h-14"
                    : showSplitFilmstrip
                      ? "h-14"
                      : "h-12"
                  : isTrimChrome && trimEditable
                    ? "h-14 cursor-default"
                    : showSplitFilmstrip
                      ? "h-14 cursor-pointer"
                      : "h-10 cursor-pointer overflow-hidden rounded-md",
                timelineInteractive
                  ? isTrimChrome && trimEditable
                    ? "cursor-default"
                    : "cursor-pointer"
                  : "pointer-events-none",
                disabled && "pointer-events-none opacity-50",
              )}
              onPointerDown={
                timelineInteractive
                  ? (e) =>
                      beginTimelinePointer(e, {
                        trim: isTrimChrome && trimEditable,
                      })
                  : undefined
              }
              onPointerMove={
                timelineInteractive ? moveTimelinePointer : undefined
              }
              onPointerUp={
                timelineInteractive ? endTimelinePointer : undefined
              }
              onPointerCancel={
                timelineInteractive ? endTimelinePointer : undefined
              }
            >
              {isTrimChrome && trimEditable ? (
                <>
                  <div className="absolute inset-0 overflow-hidden rounded-md">
                    <div className="absolute inset-0 flex bg-neutral-800">
                      {filmstripFrames && filmstripFrames.length > 0 ? (
                        filmstripFrames.map((url, i) => (
                          <div
                            key={`fs-${i}`}
                            className="h-full min-w-0 flex-1 bg-cover bg-center"
                            style={{ backgroundImage: `url(${url})` }}
                          />
                        ))
                      ) : (
                        <div className="h-full w-full bg-gradient-to-b from-neutral-700 to-neutral-900" />
                      )}
                    </div>

                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 z-[1] bg-black/55"
                      style={{ width: `${keepStart * 100}%` }}
                    />
                    <div
                      className="pointer-events-none absolute inset-y-0 right-0 z-[1] bg-black/55"
                      style={{ left: `${keepEnd * 100}%` }}
                    />

                    <div
                      className="pointer-events-none absolute z-[2] border-y-[3px]"
                      style={{
                        left: `${keepStart * 100}%`,
                        width: `${Math.max(0, keepEnd - keepStart) * 100}%`,
                        top: 0,
                        bottom: 0,
                        borderColor: TRIM_BORDER,
                      }}
                    />

                    {keyframeMarks?.map((r) => (
                      <div
                        key={`kf-${r}`}
                        className="pointer-events-none absolute inset-y-[22%] z-[2] w-px bg-white/25"
                        style={{ left: `${r * 100}%` }}
                      />
                    ))}
                  </div>

                  <div
                    className="absolute top-0 z-10 h-full -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${keepStart * 100}%`, width: 18 }}
                    aria-hidden
                  >
                    <div
                      className={cn(
                        "absolute inset-y-0 left-1/2 flex -translate-x-1/2 flex-col items-center justify-center rounded-l-[6px] shadow-md transition-transform",
                        dragHandle === "start" && "scale-105",
                      )}
                      style={{
                        width: TRIM_CAP_W,
                        backgroundColor:
                          dragHandle === "start" ? TRIM_CAP_ACTIVE : TRIM_CAP,
                      }}
                    >
                      <span className="flex gap-[3px]">
                        <span className="h-3.5 w-[2px] rounded-full bg-black/40" />
                        <span className="h-3.5 w-[2px] rounded-full bg-black/40" />
                      </span>
                    </div>
                    {dragHandle === "start" && (
                      <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-2 py-0.5 font-mono text-[11px] text-white shadow-lg">
                        {formatMs(startMsForBubble)}
                      </div>
                    )}
                  </div>

                  <div
                    className="absolute top-0 z-10 h-full -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${keepEnd * 100}%`, width: 18 }}
                    aria-hidden
                  >
                    <div
                      className={cn(
                        "absolute inset-y-0 left-1/2 flex -translate-x-1/2 flex-col items-center justify-center rounded-r-[6px] shadow-md transition-transform",
                        dragHandle === "end" && "scale-105",
                      )}
                      style={{
                        width: TRIM_CAP_W,
                        backgroundColor:
                          dragHandle === "end" ? TRIM_CAP_ACTIVE : TRIM_CAP,
                      }}
                    >
                      <span className="flex gap-[3px]">
                        <span className="h-3.5 w-[2px] rounded-full bg-black/40" />
                        <span className="h-3.5 w-[2px] rounded-full bg-black/40" />
                      </span>
                    </div>
                    {dragHandle === "end" && (
                      <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-2 py-0.5 font-mono text-[11px] text-white shadow-lg">
                        {formatMs(endMsForBubble)}
                      </div>
                    )}
                  </div>

                  <div
                    className="pointer-events-none absolute z-20"
                    style={{
                      left: `${playhead * 100}%`,
                      top: -3,
                      bottom: -3,
                      transform: "translateX(-50%)",
                    }}
                  >
                    <div className="mx-auto h-2.5 w-2.5 rounded-full bg-white shadow" />
                    <div className="mx-auto h-[calc(100%-10px)] w-[2px] bg-white shadow" />
                  </div>
                </>
              ) : (
                <>
                  <div className="absolute inset-0 overflow-hidden rounded-md ring-1 ring-inset ring-white/10">
                    <div className="absolute inset-0 flex bg-neutral-800">
                      {filmstripFrames?.map((url, i) => (
                        <div
                          key={`fs-split-${i}`}
                          className="h-full min-w-0 flex-1 bg-cover bg-center"
                          style={{ backgroundImage: `url(${url})` }}
                        />
                      ))}
                    </div>
                    {/* Soft dim left/right with a narrow undimmed seam at the cut */}
                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 z-[1] bg-black/30"
                      style={{
                        width: `${Math.max(0, playhead - 0.006) * 100}%`,
                      }}
                    />
                    <div
                      className="pointer-events-none absolute inset-y-0 right-0 z-[1] bg-black/30"
                      style={{
                        left: `${Math.min(1, playhead + 0.006) * 100}%`,
                      }}
                    />
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-px bg-white/25" />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-px bg-white/25" />
                    {keyframeMarks?.map((r) => (
                      <div
                        key={`kf-split-${r}`}
                        className="pointer-events-none absolute inset-y-[28%] z-[2] w-px bg-white/15"
                        style={{ left: `${r * 100}%` }}
                      />
                    ))}
                  </div>

                  <div
                    className="pointer-events-none absolute z-20"
                    style={{
                      left: `${playhead * 100}%`,
                      top: -3,
                      bottom: -3,
                      transform: `translateX(-50%)${
                        dragging && dragHandle == null ? " scale(1.1)" : ""
                      }`,
                    }}
                  >
                    <div
                      className="mx-auto h-2.5 w-2.5 rounded-full shadow"
                      style={{
                        backgroundColor: emphasizePlayhead
                          ? TRIM_CAP
                          : "#ffffff",
                      }}
                    />
                    <div
                      className="mx-auto w-[2px] shadow"
                      style={{
                        height: "calc(100% - 10px)",
                        backgroundColor: emphasizePlayhead
                          ? TRIM_CAP
                          : "#ffffff",
                      }}
                    />
                    {dragging && dragHandle == null ? (
                      <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-2 py-0.5 font-mono text-[11px] text-white shadow-lg">
                        {formatMs(currentMs)}
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

export { formatMs as formatPlayerTimeMs };
