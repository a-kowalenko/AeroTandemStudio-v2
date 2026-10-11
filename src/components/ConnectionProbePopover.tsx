import { useEffect, useState } from "react";
import { Server, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogActionRows } from "@/components/DialogActionRows";
import type { DialogActionStatus } from "@/store/uiStore";
import { cn } from "@/lib/utils";

/** Slightly longer than `.ats-popover-out` so the animation finishes before unmount. */
const EXIT_MS = 180;

export type ConnectionProbePopoverProps = {
  open: boolean;
  rows: DialogActionStatus[];
  /** Auto-dismiss countdown; `null` keeps the popover open until closed manually. */
  autoCloseMs?: number | null;
  onDismiss: () => void;
};

/**
 * Live connection-test panel under the header chip (no modal dialog).
 */
export function ConnectionProbePopover({
  open,
  rows,
  autoCloseMs = null,
  onDismiss,
}: ConnectionProbePopoverProps) {
  const { t } = useTranslation();
  const [rendered, setRendered] = useState(open);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    const id = window.setTimeout(() => setRendered(false), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHovered(false);
      setFocused(false);
    }
  }, [open]);

  if (!open && !rendered) return null;

  const closing = !open;
  const busy = rows.some((r) => r.busy);
  const countdown = open && autoCloseMs != null && autoCloseMs > 0;

  return (
    <div
      role="dialog"
      aria-label={t("header.connection.probeTitle")}
      aria-busy={busy || undefined}
      aria-hidden={closing || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      className={cn(
        "absolute top-full left-0 z-50 mt-1.5 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden",
        "rounded-xl border border-border/80 bg-card/95 p-3 shadow-lg backdrop-blur-md",
        closing ? "ats-popover-out" : "ats-progress-float-in",
      )}
    >
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {t("header.connection.probeTitle")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label={t("common.actions.close")}
          tabIndex={closing ? -1 : undefined}
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {rows.length > 0 ? (
        <DialogActionRows actions={rows} compact className="mt-2.5" />
      ) : null}

      {countdown ? (
        <div
          key={autoCloseMs}
          aria-hidden
          className="ats-toast-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary/60"
          style={{
            animationDuration: `${autoCloseMs}ms`,
            animationPlayState: hovered || focused ? "paused" : "running",
          }}
          onAnimationEnd={onDismiss}
        />
      ) : null}
    </div>
  );
}
