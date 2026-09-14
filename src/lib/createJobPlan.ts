/** Dynamic create-job pipeline steps for the Workflow Progress Panel. */

import { normalizeBodyConcatMode } from "./bodyConcatMode";
import { usesUnifiedIntroEncode } from "./introMuxMode";
import type { BodyConcatMode, Kunde } from "./tauri";

export type CreateJobStepId =
  | "folder"
  | "video"
  | "body-join"
  | "intro-video"
  | "intro-audio"
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
  /**
   * Frozen body-concat mode when this run will encode/join video clips.
   * Null for photo-only, preview-reuse, or no video product.
   */
  bodyConcatMode: BodyConcatMode | null;
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
  "body-join": {
    id: "body-join",
    labelKey: "workflow.createSteps.bodyJoin",
  },
  "intro-video": {
    id: "intro-video",
    labelKey: "workflow.createSteps.introVideo",
  },
  "intro-audio": {
    id: "intro-audio",
    labelKey: "workflow.createSteps.introAudio",
  },
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

/** Lokal manual entry skips marker/manifest; QR kunde always writes them. */
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
  /** Config: body concat path (frozen into the plan when video is encoded). */
  bodyConcatMode?: string | null;
  /** When true, split encode video into body-join / intro-video / intro-audio chips. */
  introEnabled?: boolean;
  /** Frozen intro mux mode — audio sub-step only for forced single-pass. */
  introMuxMode?: string | null;
};

/**
 * Freeze the step list at job start (same conditions as `export_job::create_job`
 * plus optional SMB upload in the frontend).
 */
export function buildCreateJobPlan(input: BuildCreateJobPlanInput): CreateJobPlan {
  const ids: CreateJobStepId[] = ["folder"];

  const doVideo = needsVideoProduct(input.kunde) && input.videoCount > 0;
  const encodeVideo = doVideo && !input.reusePreview;
  if (doVideo) {
    if (input.reusePreview) {
      ids.push("preview-reuse");
    } else if (input.introEnabled) {
      ids.push("body-join", "intro-video");
      if (usesUnifiedIntroEncode(input.introMuxMode)) {
        ids.push("intro-audio");
      }
    } else {
      ids.push("video");
    }
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

  // Local marker/manifest: only as its own chip when there is no SMB upload.
  // With upload, that work is invisible prep — the user-facing step is Upload.
  if (
    !input.uploadToServer &&
    !skipHandoffMarker(input.kunde.form_mode, input.manualEntryMode)
  ) {
    ids.push("handoff");
  }

  if (input.uploadToServer) {
    ids.push("upload");
  }

  ids.push("done");

  return {
    steps: ids.map((id) => STEP_DEFS[id]),
    bodyConcatMode: encodeVideo
      ? normalizeBodyConcatMode(input.bodyConcatMode)
      : null,
  };
}

/** True when the frozen plan uses intro sub-steps instead of a single video chip. */
export function planHasIntroVideoSubSteps(plan: CreateJobPlan | null): boolean {
  return plan?.steps.some((s) => s.id === "body-join") ?? false;
}

function planHasIntroAudioStep(plan: CreateJobPlan | null): boolean {
  return plan?.steps.some((s) => s.id === "intro-audio") ?? false;
}

/**
 * Map a progress status string (localized or raw German/backend) to a step id.
 * Returns null when the status does not advance the pipeline (e.g. clip detail).
 */
export function createStepIdFromStatus(
  status: string,
  plan?: CreateJobPlan | null,
): CreateJobStepId | null {
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

  if (/^video fertig|video ready/.test(s)) {
    if (planHasIntroVideoSubSteps(plan ?? null)) {
      return planHasIntroAudioStep(plan ?? null) ? "intro-audio" : "intro-video";
    }
    return "video";
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

  if (planHasIntroVideoSubSteps(plan ?? null)) {
    if (
      /audio anhängen|attach audio|adjuntar audio|adjuntando audio/.test(s)
    ) {
      return "intro-audio";
    }
    if (
      /erstelle intro|intro fertig|kodiere intro|exportiere intro\+video|füge intro|analysiere intro|zusammenfügen fertig|ohne intro \(stream-copy\)|intro\+video: hevc/.test(
        s,
      )
    ) {
      return "intro-video";
    }
    if (
      /bereite videoclips|videoclips vorbereitet|füge clips|füge kodierte clips|kodiere .*clips parallel|compatible|fast-concat|mpegts|legacy-zusammenfügen|stream-copy trim|re-encode trim|probing|compatible-probe|compatible-prep|compatible-concat|compatible-finalize|compatible-validate|container finalisieren/.test(
        s,
      )
    ) {
      return "body-join";
    }
    return null;
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
    const fromStatus = createStepIdFromStatus(opts.status, plan);
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
      // Marker/manifest writing is not a visible chip when Upload follows (or Lokal skip).
      // Do not advance the stepper on those status labels.
      if (idx < 0 && fromStatus === "handoff") {
        idx = -1;
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
    (createStepIdFromStatus(opts.status, plan) === "done" ||
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
