import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { QrPreview } from "@/lib/tauri";

type Props = {
  preview: QrPreview;
  className?: string;
  /** When false, show the frame without dimming / QR square. Default true. */
  showSpotlight?: boolean;
};

/** Hit-frame with optional QR spotlight square and dimmed surroundings. */
export function QrSpotlightPreview({
  preview,
  className,
  showSpotlight = true,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const src = convertFileSrc(preview.path);
  const spot = preview.spotlight;
  const ar =
    preview.width > 0 && preview.height > 0
      ? preview.width / preview.height
      : 16 / 9;

  return (
    <div
      className={cn(
        // Cap height on short viewports; width follows aspect so parents can size to the frame.
        "relative mx-auto min-h-0 min-w-0 max-h-[min(50vh,28rem)] max-w-full overflow-hidden rounded-md border border-border/60 bg-black",
        className,
      )}
      style={{
        aspectRatio: String(ar),
        width: `min(100%, calc(min(50vh, 28rem) * ${ar}))`,
        height: "auto",
      }}
    >
      <img
        src={src}
        alt="QR-Treffer Frame"
        className="absolute inset-0 h-full w-full object-fill"
        draggable={false}
        onLoad={() => setLoaded(true)}
      />
      {showSpotlight && spot && loaded ? (
        // Extra clip layer so the 9999px dim shadow never paints over sibling UI.
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute rounded-[3px] border-2 border-success shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-opacity duration-200"
            style={{
              left: `${spot.x * 100}%`,
              top: `${spot.y * 100}%`,
              width: `${spot.size * 100}%`,
              aspectRatio: "1",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
