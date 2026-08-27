import type { MouseEventHandler, ReactNode } from "react";
import { Film } from "lucide-react";
import type { ThumbQuality } from "@/lib/sdCard";
import { cn } from "@/lib/utils";

export type SdTilePreviewPlaceholder = "pulse" | "video-icon" | "dark" | "none";
export type SdTilePreviewLayout = "grid" | "inline";

export type SdTilePreviewProps = {
  thumbUrl?: string;
  thumbQuality?: ThumbQuality;
  /** IntersectionObserver / thumbnail loader path (optional). */
  thumbPath?: string;
  /** LQ blur/scale off, e.g. when video plays over the poster. */
  suppressLqEnhance?: boolean;
  placeholder?: SdTilePreviewPlaceholder;
  /** `grid` = 16:9 tile; `inline` = fill a fixed-size parent (details row). */
  layout?: SdTilePreviewLayout;
  className?: string;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children?: ReactNode;
};

function PreviewPlaceholder({ variant }: { variant: SdTilePreviewPlaceholder }) {
  if (variant === "none") return null;

  if (variant === "pulse") {
    return (
      <div
        className="absolute inset-0 z-0 animate-pulse bg-gradient-to-br from-muted/60 to-muted/20"
        aria-hidden
      />
    );
  }

  if (variant === "dark") {
    return (
      <div
        className="absolute inset-0 z-0 flex h-full w-full items-center justify-center bg-black/80"
        aria-hidden
      >
        <Film className="h-8 w-8 text-white/40" />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-0 flex h-full w-full items-center justify-center bg-gradient-to-br from-muted/50 to-black/40"
      aria-hidden
    >
      <div className="absolute inset-0 animate-pulse bg-muted/30" />
      <Film className="relative h-8 w-8 text-muted" />
    </div>
  );
}

/** Shared 16:9 SD tile preview: object-cover poster + clipped overflow. */
export function SdTilePreview({
  thumbUrl,
  thumbQuality,
  thumbPath,
  suppressLqEnhance = false,
  placeholder = "pulse",
  layout = "grid",
  className,
  onMouseEnter,
  onMouseLeave,
  onClick,
  children,
}: SdTilePreviewProps) {
  const showLqEnhance = thumbQuality === "lq" && !suppressLqEnhance;

  return (
    <div
      data-thumb-path={thumbPath}
      className={cn(
        "relative isolate overflow-hidden bg-black/90",
        layout === "grid"
          ? "aspect-video w-full shrink-0"
          : "h-full w-full",
        className,
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          className={cn(
            "absolute inset-0 z-0 h-full w-full object-cover object-center transition-[filter,transform] duration-300",
            showLqEnhance && "scale-[1.03] blur-[0.6px]",
          )}
          draggable={false}
          decoding="async"
        />
      ) : (
        <PreviewPlaceholder variant={placeholder} />
      )}
      {children}
    </div>
  );
}
