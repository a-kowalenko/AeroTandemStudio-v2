/** Dynamic create-job pipeline steps for the Workflow Progress Panel. */

import type { Kunde } from "./tauri";

export type CreateJobStepId =
  | "folder"
  | "video"
  | "preview-reuse"
  | "wm-video"
  | "photos"
  | "wm-photos"
  | "handoff"
  | "upload"
  | "done";

export type CreateJobStepDef = {
  id: CreateJobStepId;
  /** i18n key under workflow.createSteps.* */
  labelKey: string;
};

export type CreateJobPlan = {
  steps: CreateJobStepDef[];
};

export type CreateJobPipelineView = {
  steps: CreateJobStepDef[];
  /** Index of the active step; equals steps.length when fully done. */
  activeIndex: number;
  /** All planned steps completed successfully. */
  completed: boolean;
  cancelled: boolean;
  failed: boolean;
};

const STEP_DEFS: Record<CreateJobStepId, CreateJobStepDef> = {
  folder: { id: "folder", labelKey: "workflow.createSteps.folder" },
  video: { id: "video", labelKey: "workflow.createSteps.video" },
  "preview-reuse": {
    id: "preview-reuse",
    labelKey: "workflow.createSteps.previewReuse",
  },
  "wm-video": { id: "wm-video", labelKey: "workflow.createSteps.wmVideo" },
  photos: { id: "photos", labelKey: "workflow.createSteps.photos" },
  "wm-photos": { id: "wm-photos", labelKey: "workflow.createSteps.wmPhotos" },
  handoff: { id: "handoff", labelKey: "workflow.createSteps.handoff" },
  upload: { id: "upload", labelKey: "workflow.createSteps.upload" },
  done: { id: "done", labelKey: "workflow.createSteps.done" },
};

function needsVideoProduct(kunde: Kunde): boolean {
  return Boolean(kunde.handcam_video || kunde.outside_video);
}

function videoUnpaid(kunde: Kunde): boolean {
  return (
    (kunde.handcam_video && !kunde.ist_bezahlt_handcam_video) ||
    (kunde.outside_video && !kunde.ist_bezahlt_outside_video)
  );
}

function photoUnpaid(kunde: Kunde): boolean {
  return (
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto) ||
    (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto)
  );
}

/** Lokal manual entry skips AMS marker/manifest; QR kunde always writes them. */
function skipHandoffMarker(
  formMode: string,
  manualEntryMode: string | undefined,
): boolean {
  return (
    (manualEntryMode ?? "").trim().toLowerCase() === "lokal" &&
    formMode.trim() !== "kunde"
  );
}

export type BuildCreateJobPlanInput = {
  kunde: Kunde;
  videoCount: number;
  photoCount: number;
  watermarkPhotoCount: number;
  /** Config: upload after create_job. */
  uploadToServer: boolean;
  manualEntryMode?: string;
  /** OPT-9: preview will be reused as final video. */
  reusePreview?: boolean;
};

/**
 * Freeze the step list at job start (same conditions as `export_job::create_job`
 * plus optional SMB upload in the frontend).
 */
export function buildCreateJobPlan(input: BuildCreateJobPlanInput): CreateJobPlan {
  const ids: CreateJobStepId[] = ["folder"];

  const doVideo = needsVideoProduct(input.kunde) && input.videoCount > 0;
  if (doVideo) {
    ids.push(input.reusePreview ? "preview-reuse" : "video");
  }

  if (videoUnpaid(input.kunde) && input.videoCount > 0) {
    ids.push("wm-video");
  }

  if (input.photoCount > 0) {
    ids.push("photos");
  }

  if (photoUnpaid(input.kunde) && input.watermarkPhotoCount > 0) {
    ids.push("wm-photos");
  }

  if (!skipHandoffMarker(input.kunde.form_mode, input.manualEntryMode)) {
    ids.push("handoff");
  }

  if (input.uploadToServer) {
    ids.push("upload");
  }

  ids.push("done");

  return { steps: ids.map((id) => STEP_DEFS[id]) };
}

/**
 * Map a progress status string (localized or raw German/backend) to a step id.
 * Returns null when the status does not advance the pipeline (e.g. clip detail).
 */
export function createStepIdFromStatus(status: string): CreateJobStepId | null {
  const s = status.trim().toLowerCase();
  if (!s) return null;

  if (/abgebrochen|cancelled|canceled|cancelado/.test(s)) return null;

  if (
    /vorgang fertig|job done|proceso listo|create\.job\.done|vorgang abgeschlossen/.test(
      s,
    )
  ) {
    return "done";
  }

  if (
    /^upload\b|upload to server|upload zum server|uploading to server|auf server|subiendo al servidor|servidor/.test(
      s,
    )
  ) {
    return "upload";
  }

  if (
    /_fertig|ams-manifest|ams manifest|manifiesto ams|übergabe|handoff|überspringe _fertig|skip(ping)?.*_fertig|omitiendo.*_fertig|writing ams|schreibe ams|escribiendo manifiesto/.test(
      s,
    )
  ) {
    return "handoff";
  }

  if (
    /foto-wasserzeichen|photo watermark|marca de agua.*(foto|en foto)|creating photo watermark|erstelle foto-wasserzeichen|creando marca de agua en foto/.test(
      s,
    )
  ) {
    return "wm-photos";
  }

  if (
    /kopiere foto|fotos kopiert|copying photo|photos copied|copiando foto|fotos copiados/.test(
      s,
    )
  ) {
    return "photos";
  }

  if (
    /wasserzeichen-video|watermark video|marca de agua.*video|wm-video|creating watermark video|erstelle wasserzeichen|creando video con marca/.test(
      s,
    )
  ) {
    return "wm-video";
  }

  if (
    /übernehme vorschau|vorschau übernommen|preview.?reuse|using preview as final|vista previa como video|reutiliz|usando vista previa/.test(
      s,
    )
  ) {
    return "preview-reuse";
  }

  if (
    /erstelle video|creating video|crear video|creando video|video fertig|video ready|videoclips|intro|zusammenfüg|mpegts|fast-concat|stream-copy|re-encode|kodiere|clips parallel|exportiere video|ohne intro|encoding video/.test(
      s,
    )
  ) {
    return "video";
  }

  if (
    /generiere ausgabe|generating output|generando directorio|ausgabe-verzeichnis|output (dir|folder|directory)|crear carpeta|vorgang wird erstellt|creating (job|order)|creating…|proceso se está creando/.test(
      s,
    )
  ) {
    return "folder";
  }

  return null;
}

function stepIndex(plan: CreateJobPlan, id: CreateJobStepId): number {
  return plan.steps.findIndex((s) => s.id === id);
}

/**
 * Resolve pipeline view from a frozen plan + live status flags.
 * Active index only moves forward (monotonic) except on cancel/fail.
 *
 * Note: Rust emits "Vorgang fertig" at the end of `create_job`, before the
 * optional SMB upload in the frontend. That must not light the Fertig chip
 * while Upload is still pending.
 */
export function resolveCreateJobPipeline(opts: {
  plan: CreateJobPlan | null;
  status: string;
  /** Explicit upload phase after create_job returns. */
  uploading: boolean;
  busy: boolean;
  cancelled?: boolean;
  failed?: boolean;
  /** Highest step index reached so far (monotonic lock). */
  reachedIndex?: number;
}): CreateJobPipelineView | null {
  const plan = opts.plan;
  if (!plan || plan.steps.length === 0) return null;

  const cancelled = Boolean(opts.cancelled);
  const failed = Boolean(opts.failed) && !cancelled;
  const last = plan.steps.length - 1;
  const uploadIdx = stepIndex(plan, "upload");
  const hasUpload = uploadIdx >= 0;

  let activeIndex = Math.max(0, Math.min(opts.reachedIndex ?? 0, last));

  // Never treat Fertig as reached while upload is still ahead.
  if (hasUpload && activeIndex > uploadIdx && (opts.uploading || opts.busy)) {
    activeIndex = uploadIdx;
  }

  if (opts.uploading && hasUpload) {
    activeIndex = uploadIdx;
  } else {
    const fromStatus = createStepIdFromStatus(opts.status);
    if (fromStatus) {
      let idx = stepIndex(plan, fromStatus);
      // Preview-reuse plan uses that id; if status says "video" map to preview-reuse.
      if (idx < 0 && fromStatus === "video") {
        idx = stepIndex(plan, "preview-reuse");
      }
      // Preview-reuse status but plan has encode video — stay on video.
      if (idx < 0 && fromStatus === "preview-reuse") {
        idx = stepIndex(plan, "video");
      }
      // Lokal skip: handoff labels with no handoff step → next terminal step.
      if (idx < 0 && fromStatus === "handoff") {
        idx = stepIndex(plan, "upload");
        if (idx < 0) idx = stepIndex(plan, "done");
      }
      // create_job "done" before optional upload → park on Upload, not Fertig.
      if (
        fromStatus === "done" &&
        hasUpload &&
        (opts.busy || opts.uploading)
      ) {
        idx = uploadIdx;
      }
      if (idx >= 0) {
        // Cap so we never leap past Upload while work is still running.
        if (
          hasUpload &&
          (opts.busy || opts.uploading) &&
          idx > uploadIdx
        ) {
          idx = uploadIdx;
        }
        activeIndex = Math.max(activeIndex, idx);
      }
    }
  }

  const completed =
    !cancelled &&
    !failed &&
    !opts.busy &&
    !opts.uploading &&
    (createStepIdFromStatus(opts.status) === "done" ||
      activeIndex >= last ||
      /vorgang fertig|job done|proceso listo/i.test(opts.status.trim()));

  if (completed) {
    activeIndex = last;
  }

  return {
    steps: plan.steps,
    activeIndex,
    completed,
    cancelled,
    failed,
  };
}
