import type { HandoffStatus, VorgangEntry } from "@/lib/vorgangHistory";

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
