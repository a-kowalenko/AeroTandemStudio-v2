import type { HandoffStatus, VorgangEntry } from "@/lib/vorgangHistory";
import { isAmsHandoffTerminal } from "@/lib/amsHandoffStatus";

export function applyHandoffToEntry(
  entry: VorgangEntry,
  status: HandoffStatus,
): VorgangEntry {
  return {
    ...entry,
    ams_state: status.state,
    ams_updated_at: status.updated_at || entry.ams_updated_at,
    ams_verified_at: status.verified_at || entry.ams_verified_at,
    ams_error_code: status.error?.code ?? "",
    ams_error_message: status.error?.message ?? "",
    ams_archive: status.ams.archive ?? "",
    ams_source: status.source ?? entry.ams_source,
  };
}

export function applyAppendStatusToEntry(
  entry: VorgangEntry,
  status: HandoffStatus,
): VorgangEntry {
  if (entry.last_append_correlation_id.trim() !== status.correlation_id.trim()) {
    return entry;
  }
  return {
    ...entry,
    last_append_ams_state: status.state,
    last_append_ams_error_code: status.error?.code ?? "",
    last_append_ams_error_message: status.error?.message ?? "",
  };
}

/** History rows store UTC wall clock without a timezone marker. */
function parseAmsTimestamp(iso: string): number {
  const s = iso.trim();
  if (!s) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  return Date.parse(hasZone ? s : `${s}Z`);
}

export const AMS_STATUS_STALE_MS = 3 * 60 * 1000;

/**
 * True when ATS has not confirmed AMS status recently.
 * Uses `verified_at` (last Bridge/Outbox read), not AMS event `updated_at`.
 */
export function isAmsStatusStale(
  verifiedAt: string | null | undefined,
  state: string | null | undefined,
  opts?: { offline?: boolean },
): boolean {
  if (opts?.offline) return true;
  const s = (state ?? "").trim().toLowerCase();
  if (isAmsHandoffTerminal(s) && s !== "completed") return false;
  const t = parseAmsTimestamp(verifiedAt ?? "");
  if (Number.isNaN(t)) return (verifiedAt ?? "").trim().length === 0;
  return Date.now() - t > AMS_STATUS_STALE_MS;
}
