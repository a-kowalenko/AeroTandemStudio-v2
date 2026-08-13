import type { ReactNode } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import { cn } from "../lib/utils";

type MediaEditRotateBarProps = {
  degrees: number;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onReset?: () => void;
  disabled?: boolean;
  className?: string;
  /** Optional quiet caption (Apple keeps chrome minimal). */
  hint?: string | null;
};

/** Circular rotate tools — Photos Crop-style. */
export function MediaEditRotateBar({
  degrees,
  onRotateCw,
  onRotateCcw,
  onReset,
  disabled,
  className,
  hint,
}: MediaEditRotateBarProps) {
  const normalized = ((degrees % 360) + 360) % 360;
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="flex items-center gap-5">
        <ToolCircle
          disabled={disabled}
          onClick={onRotateCcw}
          label="90° gegen den Uhrzeigersinn"
        >
          <RotateCcw className="h-5 w-5" strokeWidth={1.75} />
        </ToolCircle>
        <div className="min-w-[3.25rem] text-center font-mono text-sm tabular-nums text-muted">
          {normalized}°
        </div>
        <ToolCircle
          disabled={disabled}
          onClick={onRotateCw}
          label="90° im Uhrzeigersinn"
        >
          <RotateCw className="h-5 w-5" strokeWidth={1.75} />
        </ToolCircle>
      </div>
      {onReset ? (
        <button
          type="button"
          disabled={disabled || normalized === 0}
          onClick={onReset}
          className={cn(
            "h-5 text-[13px] font-medium text-accent transition hover:text-foreground disabled:opacity-40",
            normalized === 0 && "invisible",
          )}
        >
          Zurücksetzen
        </button>
      ) : (
        <div className="h-5" aria-hidden />
      )}
      {hint ? (
        <p className="max-w-sm text-center text-[11px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ToolCircle({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-full bg-black/8 text-foreground transition dark:bg-white/10",
        "hover:bg-black/12 active:scale-95 dark:hover:bg-white/16",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
