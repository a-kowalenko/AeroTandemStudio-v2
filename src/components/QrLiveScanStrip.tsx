import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Eraser, QrCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { fileBaseName } from "@/lib/qrSuccess";
import {
  alignVideoLiveThumbs,
  placeQrLiveFrames,
  type PlacedQrLive,
} from "@/lib/qrLiveLayout";
import {
  useQrScanStore,
  type QrLiveFrame,
  type QrLiveTone,
} from "@/store/qrScanStore";

const MISS_HOLD_MS = 980;
const REMOVED_HOLD_MS = 720;
const CROSSFADE_MS = 480;

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
    if (src === shownRef.current || src === incoming) return;
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

function LiveTile({
  frame,
  inward = false,
  anchor = false,
  fill = false,
  index = -1,
  total = 0,
  showPosition = false,
}: {
  frame: QrLiveFrame;
  /** Right-hand side: sweep the scanline back toward the list middle. */
  inward?: boolean;
  /** Follow-up hit, centered and slightly larger. */
  anchor?: boolean;
  /** Sit in a progress-bar column instead of the fixed strip size. */
  fill?: boolean;
  /** 0-based list index. Shown inside photo tiles only. */
  index?: number;
  total?: number;
  showPosition?: boolean;
}) {
  const { t } = useTranslation();
  const clearLiveFrame = useQrScanStore((s) => s.clearLiveFrame);
  const src = liveSrc(frame);
  const { base, incoming, ready, onIncomingLoad, onIncomingError } = useCrossfadeSrc(src);
  const name = fileBaseName(frame.mediaPath);
  const tone = frame.tone;
  const hasPosition = showPosition && index >= 0 && total > 0;
  const positionLabel = hasPosition
    ? t("qr.progress.liveIndex", { index: index + 1, total })
    : null;
  const layoutMotion = !fill && !anchor;
  const leaving = tone === "miss";
  const [open, setOpen] = useState(false);
  const leftRef = useRef(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (tone !== "miss" && tone !== "removed") return;
    const ms = tone === "removed" ? REMOVED_HOLD_MS : MISS_HOLD_MS;
    const id = window.setTimeout(() => clearLiveFrame(frame.mediaPath), ms);
    return () => window.clearTimeout(id);
  }, [tone, frame.mediaPath, clearLiveFrame]);

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
        : tone === "miss"
          ? t("qr.progress.liveMiss")
          : t("qr.progress.liveScanning");

  return (
    <div
      className={cn(
        "ats-qr-live-frame",
        fill && "ats-qr-live-frame-fill",
        anchor && "ats-qr-live-frame-anchor",
        inward && !anchor && "ats-qr-live-frame-end",
        open && !leaving && "is-open",
        leaving && "is-leaving",
      )}
      onTransitionEnd={(e) => {
        if (!leaving) return;
        if (layoutMotion) {
          if (e.target !== e.currentTarget || e.propertyName !== "width") return;
        } else if (e.propertyName !== "opacity") {
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
            anchor && "ats-qr-live-tile-anchor",
            fill && "ats-qr-live-tile-fill",
          )}
          data-tone={tone}
          title={positionLabel ? `${name} — ${badge} — ${positionLabel}` : `${name} — ${badge}`}
        >
          <div className="ats-qr-live-media">
            <img
              src={base}
              alt={t("qr.progress.liveAlt", { name })}
              className="ats-qr-live-img"
              draggable={false}
            />
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
            className={cn("ats-qr-live-scanline", tone === "removed" && "is-off")}
            aria-hidden
          />
          <span
            className={cn("ats-qr-live-reticle", tone === "removed" && "is-off")}
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

/** Reserved slot above one video progress bar. Empty until that clip has a frame. */
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
  return (
    <div className="ats-qr-live-slot">
      {frame ? <LiveTile frame={frame} inward={inward} fill /> : null}
    </div>
  );
}

/** Live decode frames. Video batches render inside the progress columns instead. */
export function QrLiveScanStrip() {
  const { t } = useTranslation();
  const busy = useQrScanStore((s) => s.busy);
  const frames = useQrScanStore((s) => s.liveFrames);
  const scanOrder = useQrScanStore((s) => s.scanOrder);
  const stage = useQrScanStore((s) => s.stage);
  const anchorKey = useQrScanStore((s) => s.liveAnchorKey);
  if (
    !busy ||
    frames.length === 0 ||
    alignVideoLiveThumbs(stage, scanOrder.length)
  ) {
    return null;
  }

  const layout = placeQrLiveFrames(
    frames,
    scanOrder,
    stage === "followup" ? anchorKey : null,
  );
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
        {layout.hit ? (
          <LiveTile
            frame={layout.hit.item}
            anchor
            index={layout.hit.index}
            total={layout.total}
            showPosition={showPosition}
          />
        ) : bothSides ? (
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
