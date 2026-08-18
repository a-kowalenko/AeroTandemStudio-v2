/** AMS handoff status helpers for Historie UI (ATS ↔ AMS Outbox / Bridge). */

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
  { id: "pending", label: "Übertragen" },
  { id: "accepted", label: "Übernommen" },
  { id: "queued", label: "Warteschlange" },
  { id: "uploading", label: "Upload" },
  { id: "completed", label: "Fertig" },
] as const;

export function isAmsHandoffTerminal(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  return s === "completed" || s === "rejected" || s === "failed";
}

export function isAmsCancelled(view: AmsHandoffView): boolean {
  const code = (view.errorCode ?? "").trim().toLowerCase();
  return (
    view.state.trim().toLowerCase() === "failed" &&
    (code === "cancelled" || code === "canceled")
  );
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
  if (isAmsCancelled(view)) return "Abgebrochen";
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return compact ? "Wartend" : "Übertragen";
    case "accepted":
      return "Übernommen";
    case "rejected":
      return "Abgelehnt";
    case "queued":
      return compact ? "Queue" : "Warteschlange";
    case "uploading":
      return "Upload";
    case "completed":
      return compact ? "Fertig" : "In AMS fertig";
    case "failed":
      return "Fehler";
    default:
      return view.state.trim() || "—";
  }
}

export function handoffStateHint(view: AmsHandoffView): string | null {
  if (view.offline) {
    return "Status offline (letzter bekannter Stand)";
  }
  if (isAmsCancelled(view)) {
    return view.errorMessage?.trim() || "Upload abgebrochen";
  }
  if (view.state === "pending" || view.state === "") {
    return "Wartet auf AMS";
  }
  if (view.state === "rejected" || view.state === "failed") {
    const code = view.errorCode?.trim();
    const msg = view.errorMessage?.trim();
    if (code && msg) return `${code}: ${msg}`;
    return msg || code || null;
  }
  if (view.archive) {
    return `Archiv ${view.archive}`;
  }
  return null;
}

/** Tailwind classes for compact status chips. */
export function handoffChipClass(view: AmsHandoffView): string {
  if (isAmsCancelled(view)) {
    return "border-border/70 bg-muted/50 text-muted-foreground";
  }
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200";
    case "accepted":
      return "border-cyan-500/40 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200";
    case "queued":
      return "border-amber-500/45 bg-amber-500/10 text-amber-900 dark:text-amber-100";
    case "uploading":
      return "border-violet-500/40 bg-violet-500/10 text-violet-900 dark:text-violet-100";
    case "completed":
      return "border-emerald-500/45 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100";
    case "rejected":
    case "failed":
      return "border-destructive/50 bg-destructive/10 text-destructive";
    default:
      return "border-border/60 bg-muted/40 text-muted-foreground";
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
