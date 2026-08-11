import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { QrPreview } from "@/lib/tauri";

type Props = {
  preview: QrPreview;
  className?: string;
};

/** Hit-frame with QR spotlight square and dimmed surroundings. */
export function QrSpotlightPreview({ preview, className }: Props) {
  const [loaded, setLoaded] = useState(false);
  const src = convertFileSrc(preview.path);
  const spot = preview.spotlight;
  const aspect =
    preview.width > 0 && preview.height > 0
      ? `${preview.width} / ${preview.height}`
      : "16 / 9";

  return (
    <div
      className={cn(
        "relative min-w-0 overflow-hidden rounded-md border border-border/60 bg-black",
        className,
      )}
      style={{ aspectRatio: aspect }}
    >
      <img
        src={src}
        alt="QR-Treffer Frame"
        className="absolute inset-0 h-full w-full object-fill"
        draggable={false}
        onLoad={() => setLoaded(true)}
      />
      {spot && loaded ? (
        <div
          className="pointer-events-none absolute rounded-[3px] border-2 border-success shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-opacity duration-200"
          style={{
            left: `${spot.x * 100}%`,
            top: `${spot.y * 100}%`,
            width: `${spot.size * 100}%`,
            aspectRatio: "1",
          }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}
