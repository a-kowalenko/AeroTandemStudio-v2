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
 *
 * Stacks under AppChrome (z-110) like Splash/Wizard so window controls stay usable;
 * top inset keeps the panel clear of the sticky titlebar.
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
        overlayClassName="z-[100] bg-black/40 backdrop-blur-[3px] dark:bg-black/60"
        containerClassName="z-[100] items-start justify-center pt-14 pb-3 sm:pt-16 sm:pb-4"
        className={cn(
          "flex h-[min(88vh,calc(100dvh-4.75rem))] w-full max-w-[min(44rem,calc(100vw-1.25rem))] flex-col gap-0 overflow-hidden border-border bg-card p-0 text-foreground shadow-2xl",
          "grid-cols-none",
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
            className="justify-self-start rounded-md px-1.5 py-1 text-[15px] font-normal text-muted transition hover:text-foreground"
          >
            Abbrechen
          </button>
          <h2 className="text-center text-[15px] font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <button
            type="button"
            disabled={!doneEnabled}
            onClick={onDone}
            className={cn(
              "justify-self-end rounded-md px-1.5 py-1 text-[15px] font-semibold transition",
              doneEnabled
                ? "text-primary hover:brightness-110"
                : "cursor-not-allowed text-muted/40",
            )}
          >
            {doneLabel}
          </button>
        </header>

        {/* Canvas — fixed flex share so mode changes don't resize the stage */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 sm:px-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-[var(--ats-preview-stage)]">
            {children}
          </div>
        </div>

        {/* Mode tools — fixed height keeps canvas size stable across modes */}
        <div className="flex h-[6.25rem] shrink-0 items-center justify-center overflow-hidden px-3 sm:px-4">
          {controls}
        </div>

        {/* Mode rail */}
        <nav
          className="shrink-0 border-t border-border px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
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
                        ? "bg-primary-soft text-foreground"
                        : "text-muted hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full transition",
                        active ? "bg-primary text-primary-foreground" : "bg-black/8 dark:bg-white/10",
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
