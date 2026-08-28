/** Tailwind tone classes for Vorgänge-Dialog chips only (Phase 38.2). */

import {
  handoffChipClass,
  isAmsCancelled,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";
import { normalizeUploadState } from "@/lib/uploadState";

export function productChipTone(paid: boolean): string {
  return paid
    ? "bg-emerald-500/12 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100"
    : "bg-muted/30 text-muted-foreground ring-border/60";
}

export function uploadChipTone(state: string): string {
  const s = normalizeUploadState(state);
  if (s === "failed") {
    return "bg-destructive/10 text-destructive ring-destructive/35";
  }
  if (s === "uploading") {
    return "bg-primary/10 text-primary ring-primary/30";
  }
  if (s === "cancelled") {
    return "bg-muted/40 text-muted-foreground ring-border/60";
  }
  return "bg-warning/10 text-warning ring-warning/30";
}

export function amsHandoffChipTone(view: AmsHandoffView): string {
  if (isAmsCancelled(view)) {
    return "bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100";
  }
  return handoffChipClass(view);
}

export function stepperStepTone(opts: {
  reached: boolean;
  current: boolean;
  failed: boolean;
}): string {
  if (opts.failed) {
    return "bg-muted/30 text-muted-foreground/60 ring-border/50";
  }
  if (opts.current) {
    return "bg-foreground/10 font-medium text-foreground ring-foreground/25";
  }
  if (opts.reached) {
    return "bg-emerald-500/12 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100";
  }
  return "bg-transparent text-muted-foreground/70 ring-border/50";
}

export function stepperTerminalTone(cancelled: boolean): string {
  return cancelled
    ? "bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100"
    : "bg-destructive/10 text-destructive ring-destructive/35";
}

export function completeChipTone(): string {
  return "bg-emerald-500/12 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100";
}
