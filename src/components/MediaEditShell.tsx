import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
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
  /** Apple: Done is enabled only when there is something to commit. */
  doneEnabled: boolean;
  doneLabel?: string;
  children: ReactNode;
  /** Mode-specific controls between canvas and tool rail. */
  controls?: ReactNode;
};

/**
 * Apple Photos–style edit chrome:
 * top Cancel | title | Done · canvas · mode tools · bottom mode rail.
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
  doneLabel = "Fertig",
  children,
  controls,
}: MediaEditShellProps<T>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        hideCloseButton
        overlayClassName="bg-black/55 backdrop-blur-[3px] dark:bg-black/70"
        className={cn(
          "flex max-h-[min(92vh,calc(100dvh-1.25rem))] w-full max-w-[min(44rem,calc(100vw-1.25rem))] flex-col gap-0 overflow-hidden border-border/50 bg-[#0e1110] p-0 text-[#f2f5f4] shadow-2xl",
          "grid-cols-none dark:bg-[#0a0d0c]",
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description ? (
          <DialogDescription className="sr-only">{description}</DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{title}</DialogDescription>
        )}

        {/* Top bar — Cancel / title / Done */}
        <header className="grid shrink-0 grid-cols-[minmax(4.5rem,1fr)_auto_minmax(4.5rem,1fr)] items-center gap-2 px-3 pb-2 pt-3 sm:px-4">
          <button
            type="button"
            onClick={onCancel}
            className="justify-self-start rounded-md px-1.5 py-1 text-[15px] font-normal text-[#8eb8b0] transition hover:text-white"
          >
            Abbrechen
          </button>
          <h2 className="text-center text-[15px] font-semibold tracking-tight text-white">
            {title}
          </h2>
          <button
            type="button"
            disabled={!doneEnabled}
            onClick={onDone}
            className={cn(
              "justify-self-end rounded-md px-1.5 py-1 text-[15px] font-semibold transition",
              doneEnabled
                ? "text-primary hover:brightness-125"
                : "cursor-not-allowed text-white/25",
            )}
          >
            {doneLabel}
          </button>
        </header>

        {/* Canvas — must shrink so timeline/controls never cover the player */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 sm:px-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-black">
            {children}
          </div>
        </div>

        {/* Mode tools */}
        {controls ? (
          <div className="max-h-[28%] shrink-0 overflow-y-auto px-3 pb-1 pt-2 sm:max-h-none sm:px-4 sm:pt-3">
            {controls}
          </div>
        ) : null}

        {/* Mode rail */}
        <nav
          className="shrink-0 border-t border-white/10 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
          aria-label="Bearbeitungsmodus"
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
                        ? "bg-white/10 text-white"
                        : "text-white/45 hover:bg-white/5 hover:text-white/80",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full transition",
                        active ? "bg-primary text-primary-foreground" : "bg-white/8",
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
