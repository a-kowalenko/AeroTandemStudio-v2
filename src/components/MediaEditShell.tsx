import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn } from "../lib/utils";

export type MediaEditModeOption<T extends string> = {
  id: T;
  label: string;
  icon: ReactNode;
};

type MediaEditShellProps<T extends string> = {
  open: boolean;
  title: string;
  /** Visually hidden / sr path for a11y */
  description?: string | null;
  mode: T;
  modes: MediaEditModeOption<T>[];
  onModeChange: (mode: T) => void;
  onCancel: () => void;
  onDone: () => void;
  /** Primary action enabled only when there is something to commit. */
  doneEnabled: boolean;
  doneLabel?: string;
  /** Short hint while primary is disabled (e.g. no changes yet). */
  doneHint?: string | null;
  /** Hide primary row (e.g. mode that commits via its own controls). */
  hideDone?: boolean;
  children: ReactNode;
  /** Mode-specific controls between canvas and primary row. */
  controls?: ReactNode;
  /** Override default fixed controls height (e.g. taller photos tools). */
  controlsClassName?: string;
};

/**
 * ATS edit dialog chrome:
 * title · canvas · mode tools · primary Apply · mode rail.
 * Dismiss via X / Esc / overlay (onCancel). No separate Cancel button.
 */
export function MediaEditShell<T extends string>({
  open,
  title,
  description,
  mode,
  modes,
  onModeChange,
  onCancel,
  onDone,
  doneEnabled,
  doneLabel,
  doneHint,
  hideDone = false,
  children,
  controls,
  controlsClassName,
}: MediaEditShellProps<T>) {
  const { t } = useTranslation();
  const resolvedDoneLabel = doneLabel ?? t("common.actions.apply");
  const showHint = !doneEnabled && Boolean(doneHint);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        overlayClassName="z-[100] bg-black/40 backdrop-blur-[3px] dark:bg-black/60"
        containerClassName="z-[100] items-start justify-center pt-14 pb-3 sm:pt-16 sm:pb-4"
        className={cn(
          "flex h-[min(88vh,calc(100dvh-4.75rem))] w-full max-w-[min(44rem,calc(100vw-1.25rem))] flex-col gap-0 overflow-hidden border-border bg-card p-0 text-foreground shadow-2xl",
          "grid-cols-none",
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0 space-y-0 px-3 pb-2 pt-3 pr-10 sm:px-4 sm:pr-12">
          <DialogTitle className="text-base sm:text-lg">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="sr-only">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>

        {/* Canvas — fixed flex share so mode changes don't resize the stage */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 sm:px-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-[var(--ats-preview-stage)]">
            {children}
          </div>
        </div>

        {/* Mode tools — fixed height keeps canvas size stable across modes */}
        <div
          className={cn(
            "flex shrink-0 items-center justify-center overflow-hidden px-3 sm:px-4",
            controlsClassName ?? "h-[6.25rem]",
          )}
        >
          {controls}
        </div>

        {/* Primary — above mode rail (action belongs to current tools) */}
        {!hideDone ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2.5 sm:px-4">
            <p
              className={cn(
                "min-h-5 min-w-0 flex-1 truncate text-left text-xs text-muted",
                !showHint && "invisible",
              )}
              aria-hidden={!showHint}
            >
              {showHint ? doneHint : "\u00a0"}
            </p>
            <Button type="button" disabled={!doneEnabled} onClick={onDone}>
              {resolvedDoneLabel}
            </Button>
          </div>
        ) : null}

        {/* Mode rail */}
        <nav
          className="shrink-0 border-t border-border px-2 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          aria-label={t("media.edit.modeAria")}
        >
          <ul className="mx-auto flex max-w-md items-stretch justify-center gap-1 sm:gap-2">
            {modes.map((m) => {
              const active = m.id === mode;
              return (
                <li key={m.id} className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onModeChange(m.id)}
                    aria-pressed={active}
                    className={cn(
                      "flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 transition",
                      active
                        ? "bg-primary-soft text-foreground"
                        : "text-muted hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full transition",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-black/8 dark:bg-white/10",
                      )}
                    >
                      {m.icon}
                    </span>
                    <span className="max-w-full truncate text-[11px] font-medium tracking-wide">
                      {m.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </DialogContent>
    </Dialog>
  );
}
