import type { CreateJobResult } from "@/lib/tauri";

type CreateOutcomeTranslate = (
  key: string,
  options?: { count?: number; name?: string },
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
  tandemmaster?: string | null;
  videospringer?: string | null;
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

/** Compact crew line (only set roles), e.g. "TM: A · VS: B". */
export function createOutcomeCrewLine(
  info: Pick<CreateSuccessInfo, "tandemmaster" | "videospringer">,
  t: (key: string, options?: { name: string }) => string,
): string {
  const parts: string[] = [];
  const tm = info.tandemmaster?.trim();
  const vs = info.videospringer?.trim();
  if (tm) parts.push(t("create.success.crewTm", { name: tm }));
  if (vs) parts.push(t("create.success.crewVs", { name: vs }));
  return parts.join(" · ");
}

/**
 * Embedded success meta (no upload bullet — title / Fertig chip cover that).
 */
export function buildCreateOutcomeEmbeddedMeta(
  info: CreateSuccessInfo,
  t: CreateOutcomeTranslate,
): string[] {
  const parts: string[] = [];
  const videoPath = info.result.video_output?.trim() ?? "";
  if (videoPath) {
    parts.push(
      info.result.reused_preview
        ? t("create.success.videoFromPreview")
        : t("create.success.videoCreated"),
    );
  }
  const photos = info.result.photos_copied;
  if (photos > 0) {
    parts.push(
      t(
        photos === 1
          ? "create.success.photosCopied"
          : "create.success.photosCopiedMany",
        { count: photos },
      ),
    );
  }
  return parts;
}

/** Panel headline after upload finishes vs. local create summary. */
export function createOutcomeSuccessTitleKey(
  info: Pick<CreateSuccessInfo, "serverUploaded">,
): string {
  return info.serverUploaded
    ? "create.success.uploadTitle"
    : "create.success.title";
}

/**
 * When the create-outcome panel is still bound to this job, it is the success
 * UI — skip the redundant background-upload done toast.
 */
export function createOutcomeSuppressesUploadDoneToast(
  outcome: CreateRunOutcome | null | undefined,
  jobId: string,
): boolean {
  return outcome?.info.uploadJobId === jobId;
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
    // Title / Fertig chip already signal upload success — no redundant row.
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
