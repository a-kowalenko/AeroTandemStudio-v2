import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared titlebar control height. */
export const HEADER_CTRL_H = "h-8";

/** Square icon-only control (settings, SD import). */
export const HEADER_ICON_BTN = "h-8 w-8 shrink-0";

/** Labeled header button — icon + text, matching select height. */
export const HEADER_BTN = "h-8 shrink-0 gap-1.5 px-2.5 text-xs";

/**
 * Compact select trigger for the titlebar.
 * Resets default Select `h-9` / `py-2` / `text-sm`.
 */
export const HEADER_SELECT_TRIGGER =
  "h-8 gap-1.5 whitespace-nowrap px-2.5 py-0 text-xs shadow-sm focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 [&_svg.ats-select-chevron]:h-3.5 [&_svg.ats-select-chevron]:w-3.5";

/** Drive / monitor slot — fits “SD-Überwachung”, “Insta360 (USB)”. */
export const HEADER_SD_TRIGGER_W = "w-[10.5rem]";

/** Backup-mode select — fits DE “Vorher bestätigen” + chevron. */
export const HEADER_SD_MODE_W = "w-[9rem]";

/** Related titlebar controls. */
export function HeaderGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-8 items-center gap-1.5", className)}>
      {children}
    </div>
  );
}

/** Vertical rule between header groups. */
export function HeaderDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn("mx-1 h-4 w-px shrink-0 self-center bg-border", className)}
      aria-hidden
    />
  );
}
