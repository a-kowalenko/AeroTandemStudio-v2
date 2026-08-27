/** AMS handoff status helpers for Historie UI (ATS ↔ AMS Outbox / Bridge). */

import { tr } from "@/i18n";

export type AmsHandoffState =
  | "pending"
  | "accepted"
  | "rejected"
  | "queued"
  | "uploading"
  | "completed"
  | "failed"
  | string;

export type AmsHandoffView = {
  state: AmsHandoffState;
  errorCode?: string | null;
  errorMessage?: string | null;
  archive?: string | null;
  source?: string | null;
  offline?: boolean;
};

/** Filter buckets for Historie Vorgänge AMS column. */
export type AmsStatusFilter = "all" | "open" | "done" | "error";

/** Pipeline steps shown in the detail stepper (terminal reject/fail handled separately). */
export const AMS_HANDOFF_STEPS = [
  { id: "pending", label: "ams.handoff.steps.pending" },
  { id: "accepted", label: "ams.handoff.steps.accepted" },
  { id: "queued", label: "ams.handoff.steps.queued" },
  { id: "uploading", label: "ams.handoff.steps.uploading" },
  { id: "completed", label: "ams.handoff.steps.completed" },
] as const;

export function isAmsHandoffTerminal(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  return (
    s === "completed" ||
    s === "rejected" ||
    s === "failed" ||
    s === "cancelled" ||
    s === "canceled"
  );
}

export function isAmsCancelled(view: AmsHandoffView): boolean {
  const code = (view.errorCode ?? "").trim().toLowerCase();
  if (code === "cancelled" || code === "canceled") return true;
  return view.state.trim().toLowerCase() === "cancelled";
}

/** True when Historie should stop polling this handoff (terminal or cancelled). */
export function isAmsHandoffSettled(entry: {
  ams_state?: string;
  ams_error_code?: string;
}): boolean {
  if (isAmsHandoffTerminal(entry.ams_state)) return true;
  const code = (entry.ams_error_code ?? "").trim().toLowerCase();
  return code === "cancelled" || code === "canceled";
}

export function isAmsHandoffActive(view: AmsHandoffView): boolean {
  if (isAmsCancelled(view) || isAmsHandoffTerminal(view.state)) return false;
  const s = view.state.trim().toLowerCase();
  return (
    s === "" ||
    s === "pending" ||
    s === "accepted" ||
    s === "queued" ||
    s === "uploading"
  );
}

export function handoffStateLabel(
  view: AmsHandoffView,
  opts?: { compact?: boolean },
): string {
  const compact = Boolean(opts?.compact);
  if (isAmsCancelled(view)) return tr("ams.handoff.state.cancelled");
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return compact
        ? tr("ams.handoff.state.pendingCompact")
        : tr("ams.handoff.state.pending");
    case "accepted":
      return tr("ams.handoff.state.accepted");
    case "rejected":
      return tr("ams.handoff.state.rejected");
    case "queued":
      return compact
        ? tr("ams.handoff.state.queuedCompact")
        : tr("ams.handoff.state.queued");
    case "uploading":
      return tr("ams.handoff.state.uploading");
    case "completed":
      return tr("ams.handoff.state.completed");
    case "failed":
      return tr("common.status.error");
    default:
      return view.state.trim() || "—";
  }
}

export function handoffStateHint(view: AmsHandoffView): string | null {
  if (view.offline) {
    return tr("ams.handoff.hint.offline");
  }
  if (isAmsCancelled(view)) {
    return view.errorMessage?.trim() || tr("ams.handoff.hint.uploadCancelled");
  }
  if (view.state === "pending" || view.state === "") {
    return tr("ams.handoff.hint.waitingForAccept");
  }
  if (view.state === "rejected" || view.state === "failed") {
    const code = view.errorCode?.trim();
    const msg = view.errorMessage?.trim();
    if (code && msg) return `${code}: ${msg}`;
    return msg || code || null;
  }
  if (view.archive) {
    return tr("ams.handoff.hint.archive", { archive: view.archive });
  }
  return null;
}

/** Tailwind classes for compact status chips. */
export function handoffChipClass(view: AmsHandoffView): string {
  if (isAmsCancelled(view)) {
    return "bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100";
  }
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return "bg-sky-500/12 text-sky-800 ring-sky-500/30 dark:text-sky-200";
    case "accepted":
      return "bg-cyan-500/12 text-cyan-800 ring-cyan-500/30 dark:text-cyan-200";
    case "queued":
      return "bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100";
    case "uploading":
      return "bg-violet-500/12 text-violet-900 ring-violet-500/30 dark:text-violet-100";
    case "completed":
      return "bg-emerald-500/12 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100";
    case "rejected":
    case "failed":
      return "bg-destructive/10 text-destructive ring-destructive/35";
    default:
      return "bg-muted/40 text-muted-foreground ring-border/60";
  }
}

/** Index into AMS_HANDOFF_STEPS for the active pipeline step (-1 if reject/fail path). */
export function handoffStepIndex(state: string): number {
  switch (state.trim().toLowerCase()) {
    case "pending":
    case "":
      return 0;
    case "accepted":
      return 1;
    case "queued":
      return 2;
    case "uploading":
      return 3;
    case "completed":
      return 4;
    default:
      return -1;
  }
}

/**
 * Pipeline index used to color reached steps in the detail stepper.
 * For cancel without a preserved pipeline state, assume interrupt at uploading
 * (typical AMS abort) so earlier steps stay green.
 */
export function handoffProgressStepIndex(view: AmsHandoffView): number {
  const fromState = handoffStepIndex(view.state);
  if (fromState >= 0) return fromState;
  if (isAmsCancelled(view)) {
    // uploading — last step before Fertig; matches "Upload abgebrochen"
    return 3;
  }
  return -1;
}

/** Categorize a Vorgang row for AMS filter chips. */
export function amsFilterBucket(
  entry: {
    correlation_id?: string;
    ams_state?: string;
    ams_error_code?: string;
  },
): AmsStatusFilter | "none" {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return "none";
  const view = viewFromVorgangEntry(entry);
  if (!view) return "none";
  if (isAmsCancelled(view)) return "error";
  const s = view.state.trim().toLowerCase();
  if (s === "completed") return "done";
  if (s === "rejected" || s === "failed") return "error";
  return "open";
}

export function matchesAmsStatusFilter(
  entry: {
    correlation_id?: string;
    ams_state?: string;
    ams_error_code?: string;
  },
  filter: AmsStatusFilter,
): boolean {
  if (filter === "all") return true;
  return amsFilterBucket(entry) === filter;
}

export function viewFromHandoffStatus(status: {
  state: string;
  error?: { code: string; message: string } | null;
  ams?: { archive?: string | null };
  source?: string;
  offline?: boolean;
}): AmsHandoffView {
  return {
    state: status.state,
    errorCode: status.error?.code ?? null,
    errorMessage: status.error?.message ?? null,
    archive: status.ams?.archive ?? null,
    source: status.source ?? null,
    offline: Boolean(status.offline),
  };
}

export function viewFromAppendEntry(entry: {
  last_append_correlation_id?: string;
  last_append_ams_state?: string;
  last_append_ams_error_code?: string;
  last_append_ams_error_message?: string;
}): AmsHandoffView | null {
  const cid = entry.last_append_correlation_id?.trim() ?? "";
  if (!cid) return null;
  const state = (entry.last_append_ams_state ?? "").trim() || "pending";
  return {
    state,
    errorCode: entry.last_append_ams_error_code || null,
    errorMessage: entry.last_append_ams_error_message || null,
    offline: false,
  };
}

export function viewFromAppendRecord(entry: {
  correlation_id?: string;
  ams_state?: string;
  ams_error_code?: string;
  ams_error_message?: string;
}): AmsHandoffView | null {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return null;
  const state = (entry.ams_state ?? "").trim() || "pending";
  return {
    state,
    errorCode: entry.ams_error_code || null,
    errorMessage: entry.ams_error_message || null,
    offline: false,
  };
}

export function viewFromVorgangEntry(entry: {
  correlation_id?: string;
  ams_state?: string;
  ams_error_code?: string;
  ams_error_message?: string;
  ams_archive?: string;
  ams_source?: string;
}): AmsHandoffView | null {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return null;
  const state = (entry.ams_state ?? "").trim() || "pending";
  return {
    state,
    errorCode: entry.ams_error_code || null,
    errorMessage: entry.ams_error_message || null,
    archive: entry.ams_archive || null,
    source: entry.ams_source || null,
    offline: false,
  };
}
