import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { QrPreview } from "@/lib/tauri";

/** Fixed landscape frame for QR hit previews (letterbox; avoids portrait layout blow-ups). */
export const QR_PREVIEW_FRAME_AR = 16 / 9;

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
  const src = convertFileSrc(preview.path);
  const spot = preview.spotlight;
  const nativeAr =
    preview.width > 0 && preview.height > 0
      ? preview.width / preview.height
      : QR_PREVIEW_FRAME_AR;
  const isPortraitOrNarrow = nativeAr < QR_PREVIEW_FRAME_AR;

  return (
    <div
      className={cn(
        // Always landscape; cap height on short viewports. Portrait media letterboxes inside.
        "relative mx-auto aspect-video min-h-0 min-w-0 max-h-[min(50vh,28rem)] max-w-full overflow-hidden rounded-md border border-border/60 bg-black",
        className,
      )}
      style={{
        width: `min(100%, calc(min(50vh, 28rem) * ${QR_PREVIEW_FRAME_AR}))`,
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative max-h-full max-w-full"
          style={{
            aspectRatio: String(nativeAr),
            // Fit native frame inside 16:9: portrait → full height; landscape → full width.
            height: isPortraitOrNarrow ? "100%" : "auto",
            width: isPortraitOrNarrow ? "auto" : "100%",
          }}
        >
          <img
            src={src}
            alt="QR-Treffer Frame"
            className="absolute inset-0 h-full w-full object-fill"
            draggable={false}
          />
          {showSpotlight && spot ? (
            // Extra clip layer so the 9999px dim shadow never paints over sibling UI.
            // Render immediately (no onLoad gate / fade) to avoid flicker when opening.
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden"
              aria-hidden
            >
              <div
                className="absolute rounded-[3px] border-2 border-success shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
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
      </div>
    </div>
  );
}
