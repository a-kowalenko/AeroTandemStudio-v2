import { cn } from "@/lib/utils";

type Props = {
  durationMs: number;
  paused: boolean;
  /** Fill color classes, e.g. `bg-success/70`. */
  className?: string;
};

/** Bottom auto-close bar; pauses via `animation-play-state` when hovered. */
export function ToastProgressBar({ durationMs, paused, className }: Props) {
  if (durationMs <= 0) return null;
  return (
    <div className="h-0.5 w-full bg-foreground/[0.06]" aria-hidden>
      <div
        className={cn("ats-toast-progress h-full origin-left", className)}
        style={{
          animationDuration: `${durationMs}ms`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </div>
  );
}
