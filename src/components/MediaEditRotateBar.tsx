import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { cn } from "../lib/utils";

type MediaEditRotateBarProps = {
  degrees: number;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onReset?: () => void;
  disabled?: boolean;
  className?: string;
  /** Optional quiet caption under the tools. */
  hint?: string | null;
};

/**
 * Controls strip: primary tools stay centered; optional reset docks to the right
 * so it never shifts the middle group.
 */
export function MediaEditControlsRow({
  children,
  reset,
  className,
}: {
  children: ReactNode;
  reset?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative flex w-full items-center justify-center", className)}>
      <div className="flex max-w-[calc(100%-2.75rem)] flex-col items-center justify-center">
        {children}
      </div>
      {reset ? (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 sm:right-1">
          {reset}
        </div>
      ) : null}
    </div>
  );
}

/** Circular rotate tools; reset docks right via MediaEditControlsRow. */
export function MediaEditRotateBar({
  degrees,
  onRotateCw,
  onRotateCcw,
  onReset,
  disabled,
  className,
  hint,
}: MediaEditRotateBarProps) {
  const { t } = useTranslation();
  const normalized = ((degrees % 360) + 360) % 360;
  const canReset = normalized !== 0;
  return (
    <MediaEditControlsRow
      className={className}
      reset={
        onReset ? (
          <MediaEditToolReset
            label={t("photo.rotate.reset")}
            disabled={disabled || !canReset}
            onClick={onReset}
          />
        ) : undefined
      }
    >
      <div className="flex items-center gap-4 sm:gap-5">
        <ToolCircle
          disabled={disabled}
          onClick={onRotateCcw}
          label={t("photo.rotate.ccw")}
        >
          <RotateCcw className="h-5 w-5" strokeWidth={1.75} />
        </ToolCircle>
        <div className="min-w-[3.25rem] text-center font-mono text-sm tabular-nums text-muted">
          {normalized}°
        </div>
        <ToolCircle
          disabled={disabled}
          onClick={onRotateCw}
          label={t("photo.rotate.cw")}
        >
          <RotateCw className="h-5 w-5" strokeWidth={1.75} />
        </ToolCircle>
      </div>
      {hint ? (
        <p className="mt-2 max-w-sm text-center text-[11px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
    </MediaEditControlsRow>
  );
}

/** Compact reset control — Undo2 to avoid looking like rotate-CCW. */
export function MediaEditToolReset({
  label,
  disabled,
  onClick,
  className,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-transparent text-muted transition",
        "hover:border-foreground/25 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/8",
        "active:scale-95",
        "disabled:pointer-events-none disabled:opacity-35",
        className,
      )}
    >
      <Undo2 className="h-4 w-4" strokeWidth={2} />
    </button>
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
