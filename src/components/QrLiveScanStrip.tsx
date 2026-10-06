import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Eraser, QrCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { mediaKind } from "@/lib/media";
import { fileBaseName } from "@/lib/qrSuccess";
import {
  alignVideoLiveThumbs,
  placeQrLiveFrames,
  type PlacedQrLive,
} from "@/lib/qrLiveLayout";
import {
  QR_LIVE_MISS_FADE_MS,
  QR_LIVE_TONE_SETTLE_MS,
  isTerminalQrLiveTone,
  presentedQrLiveTone,
  videoPlaceholderFrames,
} from "@/lib/qrLivePresent";
import { previewThumbnailQueue } from "@/lib/thumbnailQueue";
import { videoPosterBustKey } from "@/hooks/useVideoThumbnailSrc";
import { useVideoStore } from "@/store/videoStore";
import {
  normalizeMediaPath,
  useQrScanStore,
  type QrLiveFrame,
  type QrLiveTone,
  type QrScanPhase,
} from "@/store/qrScanStore";

const CROSSFADE_MS = 480;

/**
 * Photos hold the first scan so a fast miss never opens a tile. Video paints
 * that first scan at once. A later hit still waits, and miss or removal paint
 * immediately.
 */
function usePresentedQrTone(
  tone: QrLiveTone,
  immediateScan: boolean,
): QrLiveTone | null {
  const [shown, setShown] = useState<QrLiveTone | null>(() =>
    presentedQrLiveTone(null, tone, 0, QR_LIVE_TONE_SETTLE_MS, immediateScan),
  );

  useEffect(() => {
    if (isTerminalQrLiveTone(tone) || (immediateScan && tone === "scan")) {
      setShown(tone);
      return;
    }
    const id = window.setTimeout(() => setShown(tone), QR_LIVE_TONE_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [tone, immediateScan]);

  return shown;
}

function liveSrc(frame: QrLiveFrame): string {
  return `${convertFileSrc(frame.livePath)}?g=${frame.gen}`;
}

/** Keep the last frame on screen until the next JPEG has decoded, then dissolve. */
function useCrossfadeSrc(src: string): {
  base: string;
  incoming: string | null;
  ready: boolean;
  onIncomingLoad: () => void;
  onIncomingError: () => void;
} {
  const shownRef = useRef(src);
  const incomingRef = useRef<string | null>(null);
  const [base, setBase] = useState(src);
  const [incoming, setIncoming] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  incomingRef.current = incoming;

  useEffect(() => {
    if (!src || src === shownRef.current || src === incoming) return;
    if (!shownRef.current) {
      shownRef.current = src;
      setBase(src);
      setIncoming(null);
      setReady(false);
      return;
    }
    setIncoming(src);
    setReady(false);
  }, [src, incoming]);

  useEffect(() => {
    if (!incoming || !ready) return;
    let raf = 0;
    const id = window.setTimeout(() => {
      shownRef.current = incoming;
      setBase(incoming);
      raf = window.requestAnimationFrame(() => {
        setIncoming((cur) => (cur === incoming ? null : cur));
        setReady(false);
      });
    }, CROSSFADE_MS);
    return () => {
      window.clearTimeout(id);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [incoming, ready]);

  const onIncomingLoad = () => {
    const current = incomingRef.current;
    if (!current) return;
    setReady(true);
  };

  const onIncomingError = () => {
    const current = incomingRef.current;
    if (!current) return;
    setIncoming((cur) => (cur === current ? null : cur));
    setReady(false);
  };

  return { base, incoming, ready, onIncomingLoad, onIncomingError };
}

/** Import poster already in memory. Does not start a new FFmpeg job. */
function useCachedVideoPoster(mediaKey: string): string | null {
  return useVideoStore((s) => {
    const video = s.videoList.find(
      (v) => normalizeMediaPath(v.path) === mediaKey,
    );
    if (!video) return null;
    const bust = videoPosterBustKey(
      video.size_bytes,
      video.duration_secs,
      s.getMediaRevision(video.path),
    );
    return previewThumbnailQueue.getCached(video.path, bust);
  });
}

function LiveTile({
  frame,
  inward = false,
  fill = false,
  index = -1,
  total = 0,
  showPosition = false,
}: {
  frame: QrLiveFrame;
  /** Right-hand side: sweep the scanline back toward the list middle. */
  inward?: boolean;
  /** Sit in a progress-bar column instead of the fixed strip size. */
  fill?: boolean;
  /** 0-based list index. Shown inside photo tiles only. */
  index?: number;
  total?: number;
  showPosition?: boolean;
}) {
  const { t } = useTranslation();
  const clearLiveFrame = useQrScanStore((s) => s.clearLiveFrame);
  const stage = useQrScanStore((s) => s.stage);
  const immediateScan =
    stage === "scanning_videos" ||
    (stage === "scanning" && mediaKind(frame.mediaPath) === "video");
  const presented = usePresentedQrTone(frame.tone, immediateScan);
  const poster = useCachedVideoPoster(frame.key);
  const staying =
    presented === "scan" || presented === "hit" || presented === "removed";
  const openedRef = useRef(false);
  if (staying) openedRef.current = true;
  const src = frame.livePath.trim() ? liveSrc(frame) : (poster ?? "");
  const { base, incoming, ready, onIncomingLoad, onIncomingError } = useCrossfadeSrc(src);
  const name = fileBaseName(frame.mediaPath);
  const tone = presented ?? "scan";
  const hasPosition = showPosition && index >= 0 && total > 0;
  const positionLabel = hasPosition
    ? t("qr.progress.liveIndex", { index: index + 1, total })
    : null;
  const layoutMotion = !fill;
  const leaving = presented === "miss" && openedRef.current;
  const [open, setOpen] = useState(false);
  const leftRef = useRef(false);

  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.src = src;
  }, [src]);

  useEffect(() => {
    if (!staying) return;
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, [staying]);

  useEffect(() => {
    if (presented !== "miss") return;
    if (!openedRef.current) {
      clearLiveFrame(frame.mediaPath);
      return;
    }
    const id = window.setTimeout(
      () => clearLiveFrame(frame.mediaPath),
      QR_LIVE_MISS_FADE_MS,
    );
    return () => window.clearTimeout(id);
  }, [presented, frame.mediaPath, clearLiveFrame]);

  const finishLeave = () => {
    if (leftRef.current) return;
    leftRef.current = true;
    clearLiveFrame(frame.mediaPath);
  };

  const badge =
    tone === "hit"
      ? t("qr.progress.liveHit")
      : tone === "removed"
        ? t("qr.progress.liveRemoved")
        : t("qr.progress.liveScanning");
  const quiet = tone === "hit" || tone === "miss" || tone === "removed";

  if (!staying && !leaving) return null;

  return (
    <div
      className={cn(
        "ats-qr-live-frame",
        immediateScan && "ats-qr-live-frame-video",
        fill && "ats-qr-live-frame-fill",
        inward && "ats-qr-live-frame-end",
        open && !leaving && "is-open",
        leaving && "is-leaving",
      )}
      onTransitionEnd={(e) => {
        if (!leaving) return;
        if (layoutMotion) {
          if (e.target !== e.currentTarget || e.propertyName !== "width") return;
        } else if (
          e.propertyName !== "opacity" ||
          !(e.target instanceof Element) ||
          !e.target.classList.contains("ats-qr-live-motion")
        ) {
          return;
        }
        finishLeave();
      }}
    >
      <div className="ats-qr-live-motion">
        <div
          className={cn(
            "ats-qr-live-tile",
            toneClass(tone),
            inward && "ats-qr-live-tile-inward",
            fill && "ats-qr-live-tile-fill",
          )}
          data-tone={tone}
          title={positionLabel ? `${name} — ${badge} — ${positionLabel}` : `${name} — ${badge}`}
        >
          <div className="ats-qr-live-media">
            {base ? (
              <img
                src={base}
                alt={t("qr.progress.liveAlt", { name })}
                className="ats-qr-live-img"
                draggable={false}
              />
            ) : null}
            {incoming ? (
              <img
                src={incoming}
                alt=""
                aria-hidden
                className={cn(
                  "ats-qr-live-img ats-qr-live-img-next",
                  ready && "is-in",
                )}
                draggable={false}
                onLoad={(e) => {
                  if (e.currentTarget.getAttribute("src") === incoming) onIncomingLoad();
                }}
                onError={() => onIncomingError()}
              />
            ) : null}
          </div>
          <div className="ats-qr-live-vignette" aria-hidden />
          <span
            className={cn("ats-qr-live-scanline", quiet && "is-off")}
            aria-hidden
          />
          <span
            className={cn(
              "ats-qr-live-reticle",
              (tone === "removed" || tone === "miss") && "is-off",
            )}
            aria-hidden
          />
          {tone === "removed" ? (
            <span className="ats-qr-live-wipe" aria-hidden />
          ) : null}
          {hasPosition ? (
            <span className="ats-qr-live-pos" aria-hidden>
              <span className="ats-qr-live-pos-index">{index + 1}</span>
              <span className="ats-qr-live-pos-total">{total}</span>
            </span>
          ) : null}
          {tone === "miss" ? null : (
            <span className="ats-qr-live-badge">
              {tone === "hit" ? (
                <Check className="h-3 w-3" aria-hidden />
              ) : tone === "removed" ? (
                <Eraser className="h-3 w-3" aria-hidden />
              ) : (
                <QrCode className="h-3 w-3" aria-hidden />
              )}
              <span>{badge}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function toneClass(tone: QrLiveTone): string {
  if (tone === "hit") return "ats-qr-live-tile-hit";
  if (tone === "miss") return "ats-qr-live-tile-miss";
  if (tone === "removed") return "ats-qr-live-tile-removed";
  return "ats-qr-live-tile-scan";
}

function Dock({
  frames,
  total,
  inward = false,
  showPosition = false,
}: {
  frames: PlacedQrLive<QrLiveFrame>[];
  total: number;
  inward?: boolean;
  showPosition?: boolean;
}) {
  return (
    <div className={cn("ats-qr-live-dock", inward && "ats-qr-live-dock-end")}>
      {frames.map((placed) => (
        <LiveTile
          key={placed.item.key}
          frame={placed.item}
          inward={inward}
          index={placed.index}
          total={total}
          showPosition={showPosition}
        />
      ))}
    </div>
  );
}

function placeholderFor(
  mediaKey: string,
  phase: QrScanPhase | null,
  mediaPath: string,
): QrLiveFrame | null {
  const [frame] = videoPlaceholderFrames(
    [mediaKey],
    phase ? { [mediaKey]: phase } : {},
    new Set(),
    () => mediaPath,
  );
  return frame ?? null;
}

/** Reserved slot above one video progress bar. Poster or scanline as soon as the clip starts. */
export function QrSegmentLiveSlot({
  mediaKey,
  inward = false,
}: {
  mediaKey: string;
  inward?: boolean;
}) {
  const frame = useQrScanStore(
    (s) => s.liveFrames.find((f) => f.key === mediaKey) ?? null,
  );
  const phase = useQrScanStore((s) => s.byPath[mediaKey] ?? null);
  const mediaPath = useVideoStore(
    (s) =>
      s.videoList.find((v) => normalizeMediaPath(v.path) === mediaKey)?.path ??
      mediaKey,
  );
  const display = frame ?? placeholderFor(mediaKey, phase, mediaPath);
  return (
    <div className="ats-qr-live-slot">
      {display ? <LiveTile frame={display} inward={inward} fill /> : null}
    </div>
  );
}

/** Live decode frames. Video batches render inside the progress columns instead. */
export function QrLiveScanStrip() {
  const { t } = useTranslation();
  const busy = useQrScanStore((s) => s.busy);
  const frames = useQrScanStore((s) => s.liveFrames);
  const byPath = useQrScanStore((s) => s.byPath);
  const scanOrder = useQrScanStore((s) => s.scanOrder);
  const stage = useQrScanStore((s) => s.stage);
  const videoPaths = useVideoStore((s) => s.videoList);
  const showPlaceholders = stage === "scanning_videos" || stage === "scanning";
  const displayFrames = showPlaceholders
    ? [
        ...frames,
        ...videoPlaceholderFrames(
          scanOrder,
          byPath,
          new Set(frames.map((f) => f.key)),
          (key) =>
            videoPaths.find((v) => normalizeMediaPath(v.path) === key)?.path ??
            key,
        ).filter(
          (f) =>
            stage === "scanning_videos" || mediaKind(f.mediaPath) === "video",
        ),
      ]
    : frames;
  if (
    !busy ||
    displayFrames.length === 0 ||
    alignVideoLiveThumbs(stage, scanOrder.length)
  ) {
    return null;
  }

  // The hit stays in its dock. Pulling it into the center remounts the tile.
  const layout = placeQrLiveFrames(displayFrames, scanOrder);
  const bothSides = layout.start.length > 0 && layout.end.length > 0;
  const showPosition = stage === "scanning_photos" || stage === "followup";

  return (
    <div
      className="ats-qr-live-strip"
      role="group"
      aria-label={t("qr.progress.liveAria")}
    >
      <Dock
        frames={layout.start}
        total={layout.total}
        showPosition={showPosition}
      />
      <div className="ats-qr-live-center">
        {bothSides ? (
          <span className="ats-qr-live-bridge-gap" aria-hidden>
            ···
          </span>
        ) : null}
      </div>
      <Dock
        frames={layout.end}
        total={layout.total}
        inward
        showPosition={showPosition}
      />
    </div>
  );
}
