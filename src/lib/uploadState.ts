/** SMB upload lifecycle helpers (Phase 31 / 31.8) — pure, no Tauri/store. */

export type UploadStateLike = {
  correlation_id?: string | null;
  base_output_dir?: string | null;
  upload_state?: string | null;
};

/** Normalize for comparisons; empty → "". */
export function normalizeUploadState(
  state: string | null | undefined,
): string {
  return (state ?? "").trim().toLowerCase();
}

/**
 * List chip states that need operator attention (not `none` / `done`).
 * Prefer this over AMS handoff in the Vorgänge status column.
 */
export function isListUploadStatus(
  state: string | null | undefined,
): boolean {
  const s = normalizeUploadState(state);
  return (
    s === "pending" ||
    s === "failed" ||
    s === "uploading" ||
    s === "cancelled"
  );
}

/**
 * Still expected by the system: badge, reconnect toast, bulk candidates.
 * Manual cancel is `cancelled` — retryable, but not outstanding.
 */
export function isOutstandingUploadState(
  state: string | null | undefined,
): boolean {
  const s = normalizeUploadState(state);
  return s === "pending" || s === "failed";
}

/** `pending` | `failed` | `cancelled` — Historie may offer “Upload nachholen”. */
export function isRetryableUploadState(
  state: string | null | undefined,
): boolean {
  const s = normalizeUploadState(state);
  return s === "pending" || s === "failed" || s === "cancelled";
}

export function entryHasUploadTarget(entry: UploadStateLike): boolean {
  return Boolean(
    entry.correlation_id?.trim() && entry.base_output_dir?.trim(),
  );
}

/** Whether Historie may offer “Upload nachholen” for this row. */
export function canRetryVorgangUpload(
  entry: UploadStateLike,
  uploadToServer: boolean,
): boolean {
  if (!uploadToServer) return false;
  if (!entryHasUploadTarget(entry)) return false;
  return isRetryableUploadState(entry.upload_state);
}

/** Whether this row counts toward badge / reconnect / bulk. */
export function isOutstandingVorgangUpload(
  entry: UploadStateLike,
  uploadToServer: boolean,
): boolean {
  if (!uploadToServer) return false;
  if (!entryHasUploadTarget(entry)) return false;
  return isOutstandingUploadState(entry.upload_state);
}
