import { tr } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackupProgress, WorkflowProgress } from "../lib/sdCard";
import {
  formatOverallProgressLabel,
  taskProgressLabel,
} from "../lib/progressLabels";
import {
  resolveCreateJobPipeline,
  type CreateJobPlan,
  type CreateJobPipelineView,
} from "../lib/createJobPlan";
import {
  formatWorkflowDetail,
  formatWorkflowLabel,
  inferWorkflowStage,
  resolveSdWorkflowProgress,
  workflowStageSubtitle,
  type WorkflowProgressSnapshot,
  type WorkflowProgressStage,
  type WorkflowTaskProgress,
} from "../lib/workflowProgress";
import {
  formatUploadCompactParts,
  formatUploadProgressSnapshot,
  type UploadCompactParts,
} from "../lib/uploadProgress";
import type { UploadProgressEvent } from "../lib/tauri";
import type { UploadSlotResult } from "../lib/uploadQueue";
import {
  summarizeQrScanProgress,
  type QrClipFrameProgress,
  type QrFollowupStatus,
  type QrScanJobStage,
  type QrScanPhase,
} from "../store/qrScanStore";

const COLLAPSE_AFTER_MS = 3500;
const HIDE_AFTER_MS = 9000;
/** Auto-shrink after Success-Modal close while background upload still expanded. */
const BG_AUTO_SHRINK_MS = 5000;

export type WorkflowProgressView = {
  visible: boolean;
  collapsed: boolean;
  stage: WorkflowProgressStage;
  subtitle: string;
  snapshot: WorkflowProgressSnapshot | null;
  tasks: WorkflowTaskProgress[];
  encodeLabel: string;
  canCancel: boolean;
  /** Cancel clicked; job still winding down cooperatively. */
  cancelling: boolean;
  reserveSpace: boolean;
  /** Create-job pipeline chips (null when not creating). */
  createPipeline: CreateJobPipelineView | null;
  /** Hide overall % bar; stepper + detail/tasks only. */
  hideOverallBar: boolean;
  /** Phase 37.2: compact upload bar with expand/collapse. */
  backgroundUpload: boolean;
  /** Waiting jobs behind the active slot. */
  uploadQueueCount: number;
  /** Cancel → cleanup while slot stays occupied. */
  uploadCancelPhase: "cancelling" | "cleanup" | null;
  /** Compact metrics (Bar/%/MB/Speed). */
  uploadCompact: UploadCompactParts;
  /** Failed background upload held until dismiss. */
  uploadFailedHold: boolean;
  onToggleCollapsed: () => void;
  onDismissFailedHold: () => void;
};

/** Phase 37.4: session work and background upload as separate panels. */
export type DualWorkflowProgress = {
  session: WorkflowProgressView;
  upload: WorkflowProgressView;
};

type TaskState = {
  taskId: number;
  percent: number;
  status: string;
};

type Input = {
  sdWorkflowActive: boolean;
  sdPhase: string;
  backupProgress: BackupProgress | null;
  workflowProgress: WorkflowProgress | null;
  loadingMessage: string;
  qrScanBusy: boolean;
  qrScanStage: QrScanJobStage;
  qrScanByPath: Record<string, QrScanPhase>;
  qrFollowup: QrFollowupStatus | null;
  qrClipProgress: Record<string, QrClipFrameProgress>;
  qrScanOrder: string[];
  qrPhotoEdgeLimited: boolean;
  videoImporting: boolean;
  photoImporting: boolean;
  encodeBusy: boolean;
  appendActive: boolean;
  appendGuest: string | null;
  appendUploading: boolean;
  /** Slot/queue has work (independent of session busy). */
  backgroundUploadActive?: boolean;
  uploadQueueCount?: number;
  /** Cancel/cleanup phase while slot stays occupied. */
  uploadCancelPhase?: "cancelling" | "cleanup" | null;
  /** Bumps when CreateSuccessDialog closes (auto-shrink trigger). */
  successCloseGeneration?: number;
  uploadLastOutcome?: UploadSlotResult | null;
  uploadProgress: UploadProgressEvent | null;
  percent: number;
  status: string;
  taskProgress: TaskState[];
  /** Session panel cancel in flight. */
  sessionCancelRequested?: boolean;
  /** Upload panel cancel in flight. */
  uploadCancelRequested?: boolean;
  /** Frozen create-job step plan for this run. */
  createJobPlan?: CreateJobPlan | null;
  /** Create job ended in error (not cancel). */
  createFailed?: boolean;
};

const EMPTY_UPLOAD_COMPACT: UploadCompactParts = {
  percent: 0,
  bytesLabel: null,
  speedLabel: "",
};

function noop() {}

export function useWorkflowProgress(input: Input): DualWorkflowProgress {
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [sessionCollapsed, setSessionCollapsed] = useState(false);
  const [uploadCollapsed, setUploadCollapsed] = useState(false);
  const [failedHold, setFailedHold] = useState(false);
  const wasSessionActiveRef = useRef(false);
  const wasBgUploadRef = useRef(false);
  const [createReachedIndex, setCreateReachedIndex] = useState(0);
  const createPlanIdRef = useRef<CreateJobPlan | null>(null);
  const autoShrinkTimerRef = useRef<number | null>(null);
  const prevSuccessCloseRef = useRef(input.successCloseGeneration ?? 0);

  const clearAutoShrinkTimer = () => {
    if (autoShrinkTimerRef.current != null) {
      window.clearTimeout(autoShrinkTimerRef.current);
      autoShrinkTimerRef.current = null;
    }
  };

  const sdProgress = useMemo(
    () =>
      resolveSdWorkflowProgress({
        active: input.sdWorkflowActive,
        phase: input.sdPhase,
        backupProgress: input.backupProgress,
        workflowProgress: input.workflowProgress,
        loadingMessage: input.loadingMessage,
        qrBusy: input.qrScanBusy,
        qrStage: input.qrScanStage,
        qrByPath: input.qrScanByPath,
        qrFollowup: input.qrFollowup,
        qrClipProgress: input.qrClipProgress,
        qrScanOrder: input.qrScanOrder,
        qrPhotoEdgeLimited: input.qrPhotoEdgeLimited,
      }),
    [
      input.sdWorkflowActive,
      input.sdPhase,
      input.backupProgress,
      input.workflowProgress,
      input.loadingMessage,
      input.qrScanBusy,
      input.qrScanStage,
      input.qrScanByPath,
      input.qrFollowup,
      input.qrClipProgress,
      input.qrScanOrder,
      input.qrPhotoEdgeLimited,
    ],
  );

  const mediaImporting = input.videoImporting || input.photoImporting;
  const manualImportProgress = useMemo((): WorkflowProgressSnapshot | null => {
    if (input.sdWorkflowActive || input.qrScanBusy) return null;
    if (input.workflowProgress?.stage === "import") {
      return {
        percent: input.workflowProgress.percent,
        label: formatWorkflowLabel(
          input.workflowProgress,
          tr("media.drop.importing"),
        ),
        detail: formatWorkflowDetail(input.workflowProgress),
      };
    }
    if (mediaImporting) {
      return {
        percent: 0,
        label: tr("media.drop.importing"),
        indeterminate: true,
      };
    }
    return null;
  }, [
    input.sdWorkflowActive,
    input.qrScanBusy,
    input.workflowProgress,
    mediaImporting,
  ]);

  const manualQrProgress = useMemo((): WorkflowProgressSnapshot | null => {
    if (!input.qrScanBusy || input.sdWorkflowActive) return null;
    return summarizeQrScanProgress(
      input.qrScanByPath,
      input.qrScanStage,
      input.qrFollowup,
      input.qrClipProgress,
      input.qrScanOrder,
      input.qrPhotoEdgeLimited,
    );
  }, [
    input.qrScanBusy,
    input.sdWorkflowActive,
    input.qrScanByPath,
    input.qrScanStage,
    input.qrFollowup,
    input.qrClipProgress,
    input.qrScanOrder,
    input.qrPhotoEdgeLimited,
  ]);

  const showSdProgress = Boolean(input.sdWorkflowActive && sdProgress);
  const showManualImport = Boolean(manualImportProgress);
  const showManualQr = Boolean(manualQrProgress);
  const showEncodeProgress =
    input.encodeBusy ||
    input.appendActive ||
    input.percent > 0 ||
    input.taskProgress.length > 0;

  const uploadSlotActive = Boolean(input.backgroundUploadActive);
  const uploadQueueCount = input.uploadQueueCount ?? 0;

  // Session work only — never background upload alone.
  const sessionWorkActive =
    showSdProgress ||
    showManualImport ||
    showManualQr ||
    input.encodeBusy ||
    input.appendActive ||
    input.qrScanBusy;

  const hasSessionCompletionState =
    !input.encodeBusy &&
    !input.appendActive &&
    !uploadSlotActive &&
    !failedHold &&
    (input.percent > 0 ||
      input.taskProgress.length > 0 ||
      Boolean(input.status.trim()));

  // Track fail hold when background upload ends with failure and queue empty.
  useEffect(() => {
    if (uploadSlotActive) {
      if (!wasBgUploadRef.current) {
        setUploadCollapsed(false);
      }
      wasBgUploadRef.current = true;
      setFailedHold(false);
      return;
    }
    if (wasBgUploadRef.current && input.uploadLastOutcome === "failed") {
      setFailedHold(true);
    }
    wasBgUploadRef.current = false;
  }, [uploadSlotActive, input.uploadLastOutcome]);

  const showUploadChrome = uploadSlotActive || failedHold;

  const shouldShowSession =
    !sessionDismissed &&
    (sessionWorkActive || hasSessionCompletionState || showEncodeProgress);

  // Classic collapse/hide for session jobs only (not while upload-only).
  useEffect(() => {
    if (sessionWorkActive) {
      wasSessionActiveRef.current = true;
      setSessionDismissed(false);
      setSessionCollapsed(false);
      return;
    }

    if (!wasSessionActiveRef.current || sessionDismissed) return;
    // Leftover encode % while upload runs: don't keep a session completion pill.
    if (uploadSlotActive || failedHold) {
      setSessionDismissed(true);
      setSessionCollapsed(false);
      wasSessionActiveRef.current = false;
      return;
    }

    const collapseTimer = window.setTimeout(() => {
      setSessionCollapsed(true);
    }, COLLAPSE_AFTER_MS);

    const hideTimer = window.setTimeout(() => {
      setSessionDismissed(true);
      setSessionCollapsed(false);
      wasSessionActiveRef.current = false;
    }, HIDE_AFTER_MS);

    return () => {
      window.clearTimeout(collapseTimer);
      window.clearTimeout(hideTimer);
    };
  }, [
    sessionWorkActive,
    sessionDismissed,
    uploadSlotActive,
    failedHold,
  ]);

  // Auto-shrink 5s after Success-Modal close, only if still expanded.
  useEffect(() => {
    const gen = input.successCloseGeneration ?? 0;
    if (gen === prevSuccessCloseRef.current) return;
    prevSuccessCloseRef.current = gen;

    clearAutoShrinkTimer();
    if (!uploadSlotActive) return;
    if (uploadCollapsed) return;

    autoShrinkTimerRef.current = window.setTimeout(() => {
      autoShrinkTimerRef.current = null;
      setUploadCollapsed(true);
    }, BG_AUTO_SHRINK_MS);

    return clearAutoShrinkTimer;
  }, [
    input.successCloseGeneration,
    uploadSlotActive,
    uploadCollapsed,
  ]);

  useEffect(() => () => clearAutoShrinkTimer(), []);

  // Reset monotonic create step cursor when a new plan is set.
  useEffect(() => {
    const plan = input.createJobPlan ?? null;
    if (plan !== createPlanIdRef.current) {
      createPlanIdRef.current = plan;
      setCreateReachedIndex(0);
    }
  }, [input.createJobPlan]);

  const stage = inferWorkflowStage({
    sdWorkflowActive: input.sdWorkflowActive,
    sdPhase: input.sdPhase,
    qrScanBusy: input.qrScanBusy,
    manualImport: showManualImport,
    manualQr: showManualQr,
    encodeBusy: input.encodeBusy,
    appendActive: input.appendActive,
    appendUploading: input.appendUploading,
    status: input.status,
    sdProgress,
  });

  const sessionSubtitle = workflowStageSubtitle(stage, {
    sdWorkflowActive: input.sdWorkflowActive,
    sdPhase: input.sdPhase,
    qrScanBusy: input.qrScanBusy,
    encodeBusy: input.encodeBusy,
    appendActive: input.appendActive,
    appendGuest: input.appendGuest,
    appendUploading: false,
    createUploading: false,
    manualImport: showManualImport,
    manualQr: showManualQr,
  });

  const uploadSubtitle = failedHold
    ? tr("workflow.upload.failedHold")
    : input.uploadCancelPhase === "cleanup"
      ? tr("workflow.upload.cleaningUp")
      : input.uploadCancelPhase === "cancelling" ||
          Boolean(input.uploadCancelRequested)
        ? tr("workflow.stage.cancelling")
        : tr("workflow.stage.createUploading");

  // Session pipeline: encode / append / completion (not background-upload-only).
  const sessionPipelineBase = useMemo((): CreateJobPipelineView | null => {
    const plan = input.createJobPlan ?? null;
    if (!plan) return null;
    if (input.appendActive) return null;
    if (
      !input.encodeBusy &&
      !hasSessionCompletionState &&
      stage !== "create" &&
      stage !== "done"
    ) {
      return null;
    }
    // While only upload runs, pipeline lives on the upload panel.
    if (!input.encodeBusy && (uploadSlotActive || failedHold)) {
      return null;
    }

    const cancelled =
      Boolean(input.sessionCancelRequested && !input.encodeBusy) ||
      /abgebrochen|cancelled/i.test(input.status.trim());

    return resolveCreateJobPipeline({
      plan,
      status: input.status,
      uploading: false,
      busy: input.encodeBusy,
      cancelled,
      failed: Boolean(input.createFailed),
      reachedIndex: 0,
    });
  }, [
    failedHold,
    hasSessionCompletionState,
    input.appendActive,
    input.createFailed,
    input.createJobPlan,
    input.encodeBusy,
    input.sessionCancelRequested,
    input.status,
    stage,
    uploadSlotActive,
  ]);

  // Upload pipeline: post-create background upload (plan still held).
  const uploadPipelineBase = useMemo((): CreateJobPipelineView | null => {
    const plan = input.createJobPlan ?? null;
    if (!plan) return null;
    if (input.encodeBusy || input.appendActive) return null;
    if (!uploadSlotActive && !failedHold) return null;

    const cancelled =
      Boolean(input.uploadCancelRequested) ||
      /abgebrochen|cancelled/i.test(input.status.trim());

    return resolveCreateJobPipeline({
      plan,
      status: input.status,
      uploading: true,
      busy: true,
      cancelled,
      failed: Boolean(input.createFailed) || failedHold,
      reachedIndex: 0,
    });
  }, [
    failedHold,
    input.appendActive,
    input.createFailed,
    input.createJobPlan,
    input.encodeBusy,
    input.status,
    input.uploadCancelRequested,
    uploadSlotActive,
  ]);

  useEffect(() => {
    const base = sessionPipelineBase ?? uploadPipelineBase;
    if (!base) return;
    setCreateReachedIndex((prev) => {
      let next = Math.max(prev, base.activeIndex);
      if (
        uploadPipelineBase &&
        uploadPipelineBase.steps.some((s) => s.id === "upload")
      ) {
        const uploadIdx = uploadPipelineBase.steps.findIndex(
          (s) => s.id === "upload",
        );
        if (
          uploadIdx >= 0 &&
          next > uploadIdx &&
          !uploadPipelineBase.completed
        ) {
          return uploadIdx;
        }
      }
      return next;
    });
  }, [sessionPipelineBase, uploadPipelineBase]);

  const sessionPipeline = useMemo((): CreateJobPipelineView | null => {
    if (!sessionPipelineBase) return null;
    return {
      ...sessionPipelineBase,
      activeIndex: Math.max(
        sessionPipelineBase.activeIndex,
        createReachedIndex,
      ),
    };
  }, [sessionPipelineBase, createReachedIndex]);

  const uploadPipeline = useMemo((): CreateJobPipelineView | null => {
    if (!uploadPipelineBase) return null;
    let activeIndex = Math.max(
      uploadPipelineBase.activeIndex,
      createReachedIndex,
    );
    if (
      !uploadPipelineBase.completed &&
      !uploadPipelineBase.cancelled &&
      !uploadPipelineBase.failed
    ) {
      const uploadIdx = uploadPipelineBase.steps.findIndex(
        (s) => s.id === "upload",
      );
      if (uploadIdx >= 0) activeIndex = uploadIdx;
    }
    return {
      ...uploadPipelineBase,
      activeIndex,
    };
  }, [uploadPipelineBase, createReachedIndex]);

  // --- Session snapshot (never upload progress) ---
  let sessionSnapshot: WorkflowProgressSnapshot | null = null;
  if (input.encodeBusy || input.appendActive) {
    sessionSnapshot = {
      percent: input.percent,
      label: formatOverallProgressLabel(
        input.status,
        tr("common.status.inProgress"),
      ),
    };
  } else if (showSdProgress && sdProgress) {
    sessionSnapshot = sdProgress;
  } else if (showManualImport && manualImportProgress) {
    sessionSnapshot = manualImportProgress;
  } else if (showManualQr && manualQrProgress) {
    sessionSnapshot = manualQrProgress;
  } else if (showEncodeProgress && !uploadSlotActive && !failedHold) {
    sessionSnapshot = {
      percent: input.percent,
      label: formatOverallProgressLabel(
        input.status,
        input.encodeBusy
          ? tr("common.status.inProgress")
          : tr("common.status.done"),
      ),
    };
  }

  const sessionTasks: WorkflowTaskProgress[] =
    input.encodeBusy ||
    input.appendActive ||
    (!showSdProgress &&
      !showManualImport &&
      !showManualQr &&
      showEncodeProgress &&
      !uploadSlotActive)
      ? input.taskProgress.map((t) => ({
          taskId: t.taskId,
          percent: t.percent,
          label: taskProgressLabel(t.taskId, t.status),
          status: t.status,
        }))
      : [];

  const encodeLabel = formatOverallProgressLabel(
    input.status,
    input.encodeBusy
      ? tr("common.status.inProgress")
      : tr("common.status.done"),
  );

  const sdClearing = input.sdWorkflowActive && input.sdPhase === "clearing";
  const sessionCanCancel =
    !sdClearing &&
    (input.encodeBusy ||
      input.appendActive ||
      input.qrScanBusy ||
      input.sdWorkflowActive ||
      input.videoImporting ||
      input.photoImporting);

  const sessionCancelling = Boolean(
    input.sessionCancelRequested && sessionWorkActive,
  );

  const sessionEffectiveCollapsed =
    sessionCollapsed && !sessionWorkActive;

  // --- Upload snapshot ---
  let uploadSnapshot: WorkflowProgressSnapshot | null = null;
  if (showUploadChrome) {
    if (input.uploadProgress) {
      uploadSnapshot = formatUploadProgressSnapshot(input.uploadProgress);
    } else {
      uploadSnapshot = {
        percent: input.percent,
        label: formatOverallProgressLabel(
          input.status,
          failedHold
            ? tr("workflow.upload.failedHold")
            : tr("app.upload.title"),
        ),
      };
    }
  }

  const uploadCompact = formatUploadCompactParts(
    showUploadChrome ? input.uploadProgress : null,
  );

  const uploadCancelling = Boolean(
    (input.uploadCancelRequested || input.uploadCancelPhase) &&
      showUploadChrome,
  );

  function onToggleUploadCollapsed() {
    clearAutoShrinkTimer();
    setUploadCollapsed((prev) => !prev);
  }

  function onDismissFailedHold() {
    setFailedHold(false);
  }

  const sessionVisible =
    shouldShowSession &&
    Boolean(sessionSnapshot || sessionTasks.length > 0 || sessionPipeline);

  const session: WorkflowProgressView = {
    visible: sessionVisible,
    collapsed: sessionEffectiveCollapsed,
    stage,
    subtitle: sessionCancelling
      ? tr("workflow.stage.cancelling")
      : sessionSubtitle,
    snapshot: sessionSnapshot,
    tasks: sessionTasks,
    encodeLabel,
    canCancel: sessionCanCancel,
    cancelling: sessionCancelling,
    reserveSpace: sessionVisible && !sessionEffectiveCollapsed,
    createPipeline: sessionPipeline,
    hideOverallBar: false,
    backgroundUpload: false,
    uploadQueueCount: 0,
    uploadCancelPhase: null,
    uploadCompact: EMPTY_UPLOAD_COMPACT,
    uploadFailedHold: false,
    onToggleCollapsed: noop,
    onDismissFailedHold: noop,
  };

  const upload: WorkflowProgressView = {
    visible: showUploadChrome,
    collapsed: uploadCollapsed,
    stage: "create",
    subtitle: uploadSubtitle,
    snapshot: uploadSnapshot,
    tasks: [],
    encodeLabel: tr("app.upload.title"),
    canCancel: uploadSlotActive && !failedHold,
    cancelling: uploadCancelling,
    reserveSpace: showUploadChrome,
    createPipeline: uploadPipeline,
    hideOverallBar: false,
    backgroundUpload: true,
    uploadQueueCount,
    uploadCancelPhase: input.uploadCancelPhase ?? null,
    uploadCompact,
    uploadFailedHold: failedHold,
    onToggleCollapsed: onToggleUploadCollapsed,
    onDismissFailedHold,
  };

  return { session, upload };
}
