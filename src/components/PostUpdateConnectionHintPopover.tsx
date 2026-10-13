import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAnchoredFixedPosition } from "@/hooks/useAnchoredFixedPosition";
import { cn } from "@/lib/utils";

export type PostUpdateConnectionHintPopoverProps = {
  open: boolean;
  /** Chip / root under the titlebar — portal escapes header backdrop-filter. */
  anchorRef?: RefObject<HTMLElement | null>;
  onAcknowledge: () => void;
};

export function PostUpdateConnectionHintPopover({
  open,
  anchorRef,
  onAcknowledge,
}: PostUpdateConnectionHintPopoverProps) {
  const { t } = useTranslation();
  const pos = useAnchoredFixedPosition(open, anchorRef);
  if (!open) return null;

  const panel = (
    <div
      role="dialog"
      aria-label={t("header.connection.postUpdateHint.title")}
      style={pos ? { top: pos.top, left: pos.left } : undefined}
      className={cn(
        pos
          ? "fixed z-[120] w-[min(18rem,calc(100vw-1.5rem))]"
          : "absolute top-full left-0 z-50 mt-1.5 w-[min(18rem,calc(100vw-1.5rem))]",
        "ats-liquid-glass rounded-xl border border-border bg-card p-3 shadow-lg",
        "ats-progress-float-in",
      )}
    >
      <p className="text-sm font-medium text-foreground">
        {t("header.connection.postUpdateHint.title")}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-muted">
        {t("header.connection.postUpdateHint.body")}
      </p>
      <div className="mt-2.5 flex justify-end">
        <Button type="button" size="sm" onClick={onAcknowledge}>
          {t("header.connection.postUpdateHint.ok")}
        </Button>
      </div>
    </div>
  );

  if (typeof document !== "undefined" && anchorRef) {
    return createPortal(panel, document.body);
  }
  return panel;
}
