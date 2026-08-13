import { AlertTriangle, ListOrdered, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type SdQueueToastCardProps = {
  visible: boolean;
  variant: "queued" | "dropped";
  detail?: string;
  durationMs: number;
  onDismiss: () => void;
};

export function SdQueueToastCard({
  visible,
  variant,
  detail,
  durationMs,
  onDismiss,
}: SdQueueToastCardProps) {
  const ok = variant === "queued";
  const title = ok ? "SD vorgemerkt" : "Vorgemerkte SD weg";
  const subtitle = ok
    ? "Startet nach dem aktuellen Vorgang"
    : "Nicht mehr verfügbar — aus der Warteschlange entfernt";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto relative w-[min(22.5rem,calc(100vw-2rem))] overflow-hidden rounded-2xl",
        "border shadow-[0_12px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-xl",
        "transition-all duration-300 ease-out",
        visible
          ? "translate-y-0 scale-100 opacity-100"
          : "-translate-y-2 scale-[0.96] opacity-0",
        ok
          ? "border-primary/25 bg-[color-mix(in_srgb,var(--ats-card)_88%,var(--ats-primary)_12%)]"
          : "border-warning/30 bg-[color-mix(in_srgb,var(--ats-card)_88%,var(--ats-warning)_12%)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          ok ? "bg-primary" : "bg-warning",
        )}
        aria-hidden
      />

      <div className="flex items-start gap-3 py-3.5 pr-3 pl-4">
        <div
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            ok
              ? "bg-primary/15 text-primary ring-1 ring-primary/20"
              : "bg-warning/15 text-warning ring-1 ring-warning/25",
          )}
        >
          {ok ? (
            <ListOrdered className="h-4 w-4" aria-hidden />
          ) : (
            <AlertTriangle className="h-4 w-4" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13px] leading-tight font-semibold tracking-tight text-foreground">
            {title}
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-muted">{subtitle}</p>
          {detail?.trim() ? (
            <p
              className={cn(
                "mt-2 inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5",
                "bg-foreground/[0.06] text-[11px] font-medium tracking-wide text-foreground/80 tabular-nums",
              )}
              title={detail}
            >
              {detail.trim()}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label="Hinweis schließen"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {durationMs > 0 ? (
        <div className="h-0.5 w-full bg-foreground/[0.06]" aria-hidden>
          <div
            className={cn(
              "ats-toast-progress h-full origin-left",
              ok ? "bg-primary/70" : "bg-warning/70",
            )}
            style={{ animationDuration: `${durationMs}ms` }}
          />
        </div>
      ) : null}
    </div>
  );
}
