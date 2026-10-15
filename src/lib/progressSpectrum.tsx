import { cn } from "@/lib/utils";

/** Full-track width for the inner fill so theme gradients stay anchored to the bar, not the clip. */
export function progressSpectrumInnerWidth(fillPercent: number): string {
  const p = Math.max(0, Math.min(100, fillPercent));
  if (p <= 0) return "0%";
  return `${10000 / p}%`;
}

type ProgressBarFillProps = {
  percent: number;
  background: string;
  className?: string;
  innerClassName?: string;
  animateWidth?: boolean;
  opacity?: number;
};

export function ProgressBarFill({
  percent,
  background,
  className,
  innerClassName,
  animateWidth = false,
  opacity = 1,
}: ProgressBarFillProps) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div
      className={cn(
        "h-full overflow-hidden rounded-full",
        animateWidth && "transition-[width] duration-300 ease-out",
        className,
      )}
      style={{
        width: `${clamped}%`,
        opacity,
      }}
    >
      {clamped > 0 ? (
        <div
          className={cn("h-full rounded-full", innerClassName)}
          style={{
            width: progressSpectrumInnerWidth(clamped),
            background,
          }}
        />
      ) : null}
    </div>
  );
}

const INDETERMINATE_CHUNK_PERCENT = 100 / 3;

/**
 * Rounded pill chunk + track-anchored spectrum (counter-transform in CSS).
 */
export function ProgressBarIndeterminate({
  background,
  className,
  chunkClassName,
  opacity = 0.9,
}: {
  background: string;
  className?: string;
  chunkClassName?: string;
  opacity?: number;
}) {
  return (
    <div
      className={cn(
        "h-2.5 overflow-hidden rounded-full bg-border/60",
        className,
      )}
    >
      <div
        className={cn(
          "ats-progress-indeterminate-chunk h-full w-1/3 overflow-hidden rounded-full",
          chunkClassName,
        )}
        style={{ opacity }}
      >
        <div
          className="ats-progress-indeterminate-spectrum-inner h-full rounded-full"
          style={{
            width: progressSpectrumInnerWidth(INDETERMINATE_CHUNK_PERCENT),
            background,
          }}
        />
      </div>
    </div>
  );
}
