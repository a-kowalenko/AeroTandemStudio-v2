import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type StatusToastCardProps = {
  visible: boolean;
  title: string;
  message?: string;
  durationMs: number;
  onDismiss: () => void;
};

/** Compact success toast matching SD/AMS toast chrome. */
export function StatusToastCard({
  visible,
  title,
  message,
  durationMs,
  onDismiss,
}: StatusToastCardProps) {
  const { t } = useTranslation();
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
        "border-success/25 bg-[color-mix(in_srgb,var(--ats-card)_88%,var(--ats-success)_12%)]",
      )}
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-success" aria-hidden />

      <div className="flex items-start gap-3 py-3.5 pr-3 pl-4">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-success/15 text-success ring-1 ring-success/20">
          <Check className="h-4 w-4" aria-hidden />
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13px] leading-tight font-semibold tracking-tight text-foreground">
            {title}
          </p>
          {message?.trim() ? (
            <p className="mt-1 text-[12.5px] leading-snug text-muted">{message.trim()}</p>
          ) : null}
        </div>

        <button
          type="button"
          className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label={t("sd.toast.dismiss")}
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {durationMs > 0 ? (
        <div className="h-0.5 w-full bg-foreground/[0.06]" aria-hidden>
          <div
            className="ats-toast-progress h-full origin-left bg-success/70"
            style={{ animationDuration: `${durationMs}ms` }}
          />
        </div>
      ) : null}
    </div>
  );
}
