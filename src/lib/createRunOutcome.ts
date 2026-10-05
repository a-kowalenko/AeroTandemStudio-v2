import type { CreateJobResult } from "@/lib/tauri";

type CreateOutcomeTranslate = (
  key: string,
  options?: { count?: number },
) => string;

export type CreateSuccessInfo = {
  result: CreateJobResult;
  /** True when upload ran and completed successfully. */
  serverUploaded?: boolean;
  /** True when upload was skipped because the server was offline (pending). */
  uploadDeferred?: boolean;
  /** Background upload enqueued / running (Phase 37.1). */
  uploadInProgress?: boolean;
  /** Slot job id for live progress matching. */
  uploadJobId?: string | null;
  /** Optional short note (success path or failure hint). */
  uploadNote?: string | null;
  /** Upload ended with failure / cancel (row tone). */
  uploadFailed?: boolean;
  vorname?: string | null;
  nachname?: string | null;
};

/** Non-modal create report: embedded in the upload panel or standalone card. */
export type CreateRunOutcome = {
  id: number;
  info: CreateSuccessInfo;
};

export type CreateOutcomeRow = {
  label: string;
  detail?: string;
  tone: "success" | "warning";
};

export const CREATE_OUTCOME_HIDE_MS = 8000;

let nextCreateOutcomeId = 1;

export function buildCreateRunOutcome(info: CreateSuccessInfo): CreateRunOutcome {
  return { id: nextCreateOutcomeId++, info };
}

export function pathBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function createOutcomeCustomerName(info: CreateSuccessInfo): string {
  return [info.vorname, info.nachname]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Summary rows. `embedded` drops the running-upload row — the compact upload
 * bar directly above already shows it.
 */
export function buildCreateOutcomeRows(
  info: CreateSuccessInfo,
  t: CreateOutcomeTranslate,
  opts: { embedded: boolean },
): CreateOutcomeRow[] {
  const { result, serverUploaded, uploadDeferred, uploadInProgress, uploadNote } =
    info;
  const note = uploadNote?.trim() || undefined;
  const rows: CreateOutcomeRow[] = [];

  if (result.video_output) {
    rows.push({
      label: result.reused_preview
        ? t("create.success.videoFromPreview")
        : t("create.success.videoCreated"),
      tone: "success",
    });
  }
  if (result.watermark_video) {
    rows.push({ label: t("create.success.previewVideo"), tone: "success" });
  }
  if (result.photos_copied > 0) {
    const n = result.photos_copied;
    rows.push({
      label: t(
        n === 1 ? "create.success.photosCopied" : "create.success.photosCopiedMany",
        { count: n },
      ),
      tone: "success",
    });
  }
  if (result.watermark_photos > 0) {
    const n = result.watermark_photos;
    rows.push({
      label: t(
        n === 1 ? "create.success.previewPhotos" : "create.success.previewPhotosMany",
        { count: n },
      ),
      tone: "success",
    });
  }
  if (uploadInProgress) {
    if (!opts.embedded) {
      rows.push({ label: t("create.success.uploadRunning"), detail: note, tone: "success" });
    }
  } else if (serverUploaded) {
    rows.push({ label: t("create.success.uploaded"), tone: "success" });
  } else if (uploadDeferred) {
    rows.push({
      label: t("create.success.uploadPending"),
      detail: note ?? t("create.success.uploadPendingHint"),
      tone: "warning",
    });
  } else if (note) {
    rows.push({ label: note, tone: info.uploadFailed ? "warning" : "success" });
  }
  if (rows.length === 0) {
    rows.push({ label: t("create.success.dirCreated"), tone: "success" });
  }
  return rows;
}

/**
 * 1-based position in the waiting queue; null when active or unknown.
 */
export function createOutcomeQueuePosition(
  jobId: string | null | undefined,
  activeId: string | null,
  queueIds: string[],
): number | null {
  if (!jobId || jobId === activeId) return null;
  const idx = queueIds.indexOf(jobId);
  return idx >= 0 ? idx + 1 : null;
}
