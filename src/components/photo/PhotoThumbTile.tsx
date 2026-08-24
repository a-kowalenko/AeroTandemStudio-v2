import { tr } from "@/i18n";
import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import {
  PHOTO_THUMB_HQ_DELAY_MS,
  PHOTO_THUMB_PRIORITY,
  photoThumbnailQueue,
} from "../../lib/photoThumbnailQueue";
import { QrScanRowBar, QrScanTileBadge } from "../../hooks/useQrScanProgress";
import { cn } from "../../lib/utils";
import { usePhotoThumbnailSrc } from "./usePhotoThumbnailSrc";

function rectNearlyIntersects(
  el: DOMRect,
  root: DOMRect,
  marginX: number,
  marginY: number,
): boolean {
  return (
    el.right >= root.left - marginX &&
    el.left <= root.right + marginX &&
    el.bottom >= root.top - marginY &&
    el.top <= root.bottom + marginY
  );
}

export type PhotoThumbTileProps = {
  path: string;
  filename: string;
  revision: number;
  isCurrent: boolean;
  isSelected: boolean;
  isWm: boolean;
  editMark: "crop" | "rotate" | null;
  scrollRootRef: RefObject<HTMLElement | null>;
  /** When true, skip IntersectionObserver and always request LQ (virtualized rows). */
  forceLoad?: boolean;
  /** Strip-sized tiles: QR chip shows icon only. */
  compactQrChip?: boolean;
  className?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
};

export function PhotoThumbTile({
  path,
  filename,
  revision,
  isCurrent,
  isSelected,
  isWm,
  editMark,
  scrollRootRef,
  forceLoad = false,
  compactQrChip = false,
  className,
  onClick,
  onContextMenu,
}: PhotoThumbTileProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(forceLoad);
  const [hqReady, setHqReady] = useState(false);

  useEffect(() => {
    if (forceLoad) {
      setInView(true);
      return;
    }
    const el = buttonRef.current;
    if (!el) return;

    let io: IntersectionObserver | null = null;
    let cancelled = false;
    const marginX = 100;
    const marginY = 160;

    const applyGeometry = (root: Element | null) => {
      const er = el.getBoundingClientRect();
      if (root) {
        setInView(
          rectNearlyIntersects(er, root.getBoundingClientRect(), marginX, marginY),
        );
        return;
      }
      const vr = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      } as DOMRect;
      setInView(rectNearlyIntersects(er, vr, marginX, marginY));
    };

    const connect = () => {
      if (cancelled) return;
      const root = scrollRootRef.current;
      io?.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            setInView(entry.isIntersecting);
          }
        },
        {
          root: root ?? null,
          rootMargin: `${marginY}px ${marginX}px`,
          threshold: 0.01,
        },
      );
      io.observe(el);
      const records = io.takeRecords();
      if (records.length > 0) {
        setInView(records.some((r) => r.isIntersecting));
      } else {
        applyGeometry(root);
      }
    };

    connect();
    const raf = window.requestAnimationFrame(connect);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [scrollRootRef, path, forceLoad]);

  const loading = forceLoad || isCurrent || inView;

  // Progressive LQ → HQ (EXIF resize only; no full-res / preview for tiles).
  useEffect(() => {
    if (!loading) {
      setHqReady(false);
      return;
    }
    if (photoThumbnailQueue.getCached(path, "hq", revision)) {
      setHqReady(true);
      return;
    }
    const timer = window.setTimeout(() => setHqReady(true), PHOTO_THUMB_HQ_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading, path, revision]);

  const lqPriority = loading
    ? PHOTO_THUMB_PRIORITY.visible
    : PHOTO_THUMB_PRIORITY.warm;
  const lqSrc = usePhotoThumbnailSrc(path, "lq", revision, lqPriority, {
    enabled: loading,
    fallbackToFile: false,
  });
  const hqSrc = usePhotoThumbnailSrc(
    path,
    "hq",
    revision,
    PHOTO_THUMB_PRIORITY.hqUpgrade,
    {
      enabled: loading && hqReady,
      fallbackToFile: false,
    },
  );
  const thumbSrc = hqSrc ?? lqSrc;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-thumb-path={path}
      aria-busy={loading && !thumbSrc ? true : undefined}
      className={cn(
        "relative overflow-hidden rounded-lg border-2 bg-card transition",
        isSelected
          ? "border-primary ring-2 ring-primary/25"
          : isCurrent
            ? "border-foreground/40"
            : "border-transparent opacity-80 hover:opacity-100",
        className,
      )}
      title={isWm ? `${filename} (WM)` : filename}
    >
      {thumbSrc ? (
        <img
          src={thumbSrc}
          alt={filename}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center bg-muted/40"
          aria-hidden
        >
          {loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/80" />
          )}
        </div>
      )}
      <div className="pointer-events-none absolute left-0.5 top-0.5 z-[1] flex flex-col items-start gap-0.5">
        <QrScanTileBadge path={path} compact={compactQrChip} />
        {editMark && (
          <span className="rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm">
            {editMark === "crop" ? "Crop" : "Rot"}
          </span>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-0.5 pb-0.5">
        <QrScanRowBar path={path} />
      </div>
      {isWm && (
        <>
          <img
            src="/preview_stempel.png"
            alt=""
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-[135%] max-w-[135%] -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-sm"
          />
          <span
            className="absolute top-0.5 right-0.5 rounded bg-amber-500 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
            aria-label={tr("common.actions.watermarkShort")}
          >
            WM
          </span>
        </>
      )}
    </button>
  );
}
