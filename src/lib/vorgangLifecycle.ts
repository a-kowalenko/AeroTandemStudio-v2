/**
 * Vorgang lifecycle: when local folder absence is expected vs. a problem,
 * and when Historie should still sync AMS despite a missing job folder.
 */

import {
  isAmsArchiveCancelled,
  isAmsCancelled,
  isAmsHandoffSettled,
  isAmsHandoffTerminal,
  viewFromVorgangEntry,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";
import type { VorgangEntry } from "@/lib/vorgangHistory";
import {
  isListUploadStatus,
  isRetryableUploadState,
  normalizeUploadState,
} from "@/lib/uploadState";

export type VorgangLike = Pick<
  VorgangEntry,
  | "id"
  | "correlation_id"
  | "upload_state"
  | "ams_state"
  | "ams_error_code"
  | "ams_error_message"
  | "ams_archive"
  | "base_output_dir"
>;

/** Resolve list/display AMS state; infer cancel from Abgebrochen archive path. */
export function effectiveAmsListState(
  entry: VorgangLike,
  amsState: string | null | undefined,
): string {
  const code = (entry.ams_error_code ?? "").trim().toLowerCase();
  if (code === "cancelled" || code === "canceled") {
    return "cancelled";
  }
  const raw = (amsState ?? entry.ams_state ?? "").trim();
  if (
    raw.toLowerCase() === "completed" &&
    isAmsArchiveCancelled(entry.ams_archive)
  ) {
    return "cancelled";
  }
  return raw;
}

/** Re-fetch completed handoffs — AMS may cancel after ATS recorded success. */
export function shouldReverifyCompletedHandoff(entry: VorgangLike): boolean {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return false;
  return effectiveAmsListState(entry, entry.ams_state).toLowerCase() === "completed";
}

/** Disk probe: output folder path is empty or not a directory. */
export function isFolderPhysicallyMissing(
  folderMissingById: Record<number, boolean>,
  vorgangId: number,
): boolean {
  return folderMissingById[vorgangId] === true;
}

/**
 * Server upload finished — local folder may be removed intentionally after cloud handoff.
 */
export function isPostUploadFolderCleanup(
  entry: VorgangLike,
  folderMissingById: Record<number, boolean>,
): boolean {
  if (!isFolderPhysicallyMissing(folderMissingById, entry.id)) return false;
  return normalizeUploadState(entry.upload_state) === "done";
}

/**
 * ATS still needs the on-disk job folder (retry upload, preflight, manifest).
 */
export function needsLocalJobFolder(entry: VorgangLike): boolean {
  const upload = normalizeUploadState(entry.upload_state);
  if (upload === "done" || upload === "none") return false;
  // Cancelled: show cancel chip; retry would need folder but error is not "missing folder" primary.
  if (upload === "cancelled") return false;
  return isRetryableUploadState(upload) || upload === "uploading";
}

/** Operator-facing problem: folder gone while upload/retry still expected. */
export function isFolderMissingProblem(
  entry: VorgangLike,
  folderMissingById: Record<number, boolean>,
): boolean {
  if (!isFolderPhysicallyMissing(folderMissingById, entry.id)) return false;
  return needsLocalJobFolder(entry);
}

/** AMS poll / bridge sync remains useful (no local folder required). */
export function shouldSyncAmsHandoff(
  entry: VorgangLike,
  folderMissingById: Record<number, boolean>,
): boolean {
  if (shouldReverifyCompletedHandoff(entry)) return true;
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return false;
  if (
    isAmsHandoffSettled({
      ams_state: entry.ams_state,
      ams_error_code: entry.ams_error_code,
    })
  ) {
    return false;
  }
  if (isFolderPhysicallyMissing(folderMissingById, entry.id)) {
    // After SMB done, folder cleanup is normal — still sync AMS from bridge/outbox.
    return (
      isPostUploadFolderCleanup(entry, folderMissingById) ||
      !needsLocalJobFolder(entry)
    );
  }
  return true;
}

/** List column: hide AMS chip when handoff is terminal (Phase 38.3). */
export function shouldShowAmsListChip(
  entry: VorgangLike,
  amsState: string | null | undefined,
): boolean {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return false;
  return !isAmsHandoffTerminal(effectiveAmsListState(entry, amsState));
}

function listAmsView(
  entry: VorgangLike,
  amsState: string | null | undefined,
): AmsHandoffView | null {
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) return null;
  const resolved = effectiveAmsListState(entry, amsState);
  return viewFromVorgangEntry({
    correlation_id: cid,
    ams_state: resolved || entry.ams_state,
    ams_error_code: entry.ams_error_code,
    ams_error_message: entry.ams_error_message,
    ams_archive: entry.ams_archive,
  });
}

/** Server upload done and AMS handoff completed (or no AMS correlation). */
export function isUploadSuccessfullyComplete(
  entry: VorgangLike,
  amsState: string | null | undefined,
): boolean {
  const upload = normalizeUploadState(entry.upload_state);
  const cid = entry.correlation_id?.trim() ?? "";
  if (!cid) {
    return upload === "done";
  }
  const s = effectiveAmsListState(entry, amsState).toLowerCase();
  if (s !== "completed") {
    return false;
  }
  // AMS completed — upload_state may be stale (none/pending) on legacy or unsynced rows.
  return upload === "done" || upload === "none" || upload === "pending";
}

/** Terminal AMS problem states that still deserve a list chip (cancelled / rejected / failed). */
export function isAmsTerminalProblemListChip(
  entry: VorgangLike,
  amsState: string | null | undefined,
): boolean {
  const view = listAmsView(entry, amsState);
  if (!view) return false;
  if (isAmsCancelled(view)) return true;
  const s = view.state.trim().toLowerCase();
  return (
    s === "rejected" ||
    s === "failed" ||
    s === "cancelled" ||
    s === "canceled"
  );
}

/** List column: primary status chip selection order. */
export function resolveListStatusDisplay(
  entry: VorgangLike,
  folderMissingById: Record<number, boolean>,
  amsState: string | null | undefined,
):
  | "folder_problem"
  | "upload"
  | "ams"
  | "upload_done"
  | "ams_terminal"
  | "folder_cleaned_up"
  | "none" {
  const upload = normalizeUploadState(entry.upload_state);
  if (isFolderMissingProblem(entry, folderMissingById)) {
    return "folder_problem";
  }
  if (isListUploadStatus(upload)) {
    return "upload";
  }
  if (shouldShowAmsListChip(entry, amsState)) {
    return "ams";
  }
  if (isUploadSuccessfullyComplete(entry, amsState)) {
    return "upload_done";
  }
  if (isAmsTerminalProblemListChip(entry, amsState)) {
    return "ams_terminal";
  }
  if (isPostUploadFolderCleanup(entry, folderMissingById)) {
    return "folder_cleaned_up";
  }
  return "none";
}
