import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

const ICON_SLOT =
  "inline-flex size-3 shrink-0 items-center justify-center [&>svg]:size-3";

export type HistoryStatusChipProps = {
  label: ReactNode;
  icon?: ReactNode;
  /** Reserve aligned icon column even when `icon` is omitted (default true). */
  reserveIconSlot?: boolean;
  toneClassName?: string;
  title?: string;
  active?: boolean;
  successFlash?: boolean;
  offline?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement | HTMLSpanElement>) => void;
  className?: string;
  variant?: "default" | "stepper";
  trailing?: ReactNode;
};

export function HistoryStatusChip({
  label,
  icon,
  reserveIconSlot = true,
  toneClassName,
  title,
  active,
  successFlash,
  offline,
  onClick,
  className,
  variant = "default",
  trailing,
}: HistoryStatusChipProps) {
  const classes = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 font-medium leading-tight ring-1 ring-inset transition-colors duration-300",
    variant === "default" ? "min-h-6 text-[11px]" : "text-[10px]",
    toneClassName,
    offline && "opacity-80 [ring-style:dashed]",
    active && "ams-chip-active",
    successFlash && "ams-chip-success-flash",
    onClick && "cursor-pointer hover:brightness-[1.03]",
    className,
  );

  const iconNode =
    icon ??
    (reserveIconSlot ? <span className={ICON_SLOT} aria-hidden /> : null);

  const body = (
    <>
      {iconNode}
      <span className="truncate">{label}</span>
      {trailing}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={classes} title={title} onClick={onClick}>
        {body}
      </button>
    );
  }

  return (
    <span className={classes} title={title}>
      {body}
    </span>
  );
}

export { ICON_SLOT };
