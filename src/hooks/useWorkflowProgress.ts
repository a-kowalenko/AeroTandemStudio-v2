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
/** Brief hold after background upload success before hide. */
const BG_DONE_HIDE_MS = 3500;

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
  createUploading?: boolean;
  /** True when only the background SMB slot is running (no encode). */
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
  /** User requested cancel; UI acknowledges until jobs go idle. */
  cancelRequested?: boolean;
  /** Frozen create-job step plan for this run. */
  createJobPlan?: CreateJobPlan | null;
  /** Create job ended in error (not cancel). */
  createFailed?: boolean;
};

export function useWorkflowProgress(input: Input): WorkflowProgressView {
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [failedHold, setFailedHold] = useState(false);
  const wasActiveRef = useRef(false);
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
        label: formatWorkflowLabel(input.workflowProgress, tr("media.drop.importing")),
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
  }, [input.sdWorkflowActive, input.qrScanBusy, input.workflowProgress, mediaImporting]);

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

  const backgroundUploadActive = Boolean(input.backgroundUploadActive);
  const uploadQueueCount = input.uploadQueueCount ?? 0;

  const isActive =
    showSdProgress ||
    showManualImport ||
    showManualQr ||
    input.encodeBusy ||
    input.appendActive ||
    input.qrScanBusy ||
    Boolean(input.createUploading) ||
    backgroundUploadActive;

  const hasCompletionState =
    !input.encodeBusy &&
    (input.percent > 0 || input.taskProgress.length > 0 || Boolean(input.status.trim()));

  // Track fail hold when background upload ends with failure and queue empty.
  useEffect(() => {
    if (backgroundUploadActive) {
      if (!wasBgUploadRef.current) {
        // First entry into background-upload: show expanded (Success live).
        setCollapsed(false);
      }
      wasBgUploadRef.current = true;
      setFailedHold(false);
      setDismissed(false);
      return;
    }
    if (
      wasBgUploadRef.current &&
      input.uploadLastOutcome === "failed" &&
      !isActive
    ) {
      setFailedHold(true);
      setDismissed(false);
    }
    wasBgUploadRef.current = false;
  }, [backgroundUploadActive, input.uploadLastOutcome, isActive]);

  const shouldShowPanel =
    !dismissed &&
    (isActive ||
      failedHold ||
      hasCompletionState ||
      showEncodeProgress);

  // Classic collapse/hide for non-background-upload jobs only.
  useEffect(() => {
    if (backgroundUploadActive || failedHold) {
      if (backgroundUploadActive) {
        wasActiveRef.current = true;
        setDismissed(false);
      }
      return;
    }

    if (isActive) {
      wasActiveRef.current = true;
      setDismissed(false);
      setCollapsed(false);
      return;
    }

    if (!wasActiveRef.current || dismissed) return;

    // After successful background upload: short hide (no long idle hide during upload).
    const hideDelay =
      input.uploadLastOutcome === "ok" ? BG_DONE_HIDE_MS : HIDE_AFTER_MS;

    const collapseTimer = window.setTimeout(() => {
      setCollapsed(true);
    }, COLLAPSE_AFTER_MS);

    const hideTimer = window.setTimeout(() => {
      setDismissed(true);
      setCollapsed(false);
      wasActiveRef.current = false;
    }, hideDelay);

    return () => {
      window.clearTimeout(collapseTimer);
      window.clearTimeout(hideTimer);
    };
  }, [
    isActive,
    dismissed,
    backgroundUploadActive,
    failedHold,
    input.uploadLastOutcome,
  ]);

  // Auto-shrink 5s after Success-Modal close, only if still expanded.
  useEffect(() => {
    const gen = input.successCloseGeneration ?? 0;
    if (gen === prevSuccessCloseRef.current) return;
    prevSuccessCloseRef.current = gen;

    clearAutoShrinkTimer();
    if (!backgroundUploadActive) return;
    if (collapsed) return;

    autoShrinkTimerRef.current = window.setTimeout(() => {
      autoShrinkTimerRef.current = null;
      setCollapsed(true);
    }, BG_AUTO_SHRINK_MS);

    return clearAutoShrinkTimer;
  }, [
    input.successCloseGeneration,
    backgroundUploadActive,
    collapsed,
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

  const cancelling = Boolean(
    (input.cancelRequested || input.uploadCancelPhase) && isActive,
  );
  const subtitle = failedHold
    ? tr("workflow.upload.failedHold")
    : input.uploadCancelPhase === "cleanup"
      ? tr("workflow.upload.cleaningUp")
      : input.uploadCancelPhase === "cancelling" ||
          (Boolean(input.cancelRequested) && backgroundUploadActive)
        ? tr("workflow.stage.cancelling")
        : backgroundUploadActive
          ? tr("workflow.stage.createUploading")
          : workflowStageSubtitle(stage, {
              sdWorkflowActive: input.sdWorkflowActive,
              sdPhase: input.sdPhase,
              qrScanBusy: input.qrScanBusy,
              encodeBusy: input.encodeBusy,
              appendActive: input.appendActive,
              appendGuest: input.appendGuest,
              appendUploading: input.appendUploading,
              createUploading: Boolean(input.createUploading),
              manualImport: showManualImport,
              manualQr: showManualQr,
            });

  // Keep Create-Pipeline-Stepper through background upload after session reset
  // (same chips as create: Ordner → Video → … → Upload → Fertig).
  const createPipelineBase = useMemo((): CreateJobPipelineView | null => {
    const plan = input.createJobPlan ?? null;
    if (!plan) return null;
    if (input.appendActive) return null;
    if (
      !input.encodeBusy &&
      !input.createUploading &&
      !backgroundUploadActive &&
      !failedHold &&
      !hasCompletionState &&
      stage !== "create" &&
      stage !== "done"
    ) {
      return null;
    }

    const uploadPhase =
      Boolean(input.createUploading) || backgroundUploadActive;
    const cancelled =
      Boolean(
        input.cancelRequested &&
          !input.encodeBusy &&
          !uploadPhase,
      ) || /abgebrochen|cancelled/i.test(input.status.trim());

    return resolveCreateJobPipeline({
      plan,
      status: input.status,
      uploading: uploadPhase,
      busy: input.encodeBusy || uploadPhase,
      cancelled,
      failed: Boolean(input.createFailed) || failedHold,
      reachedIndex: 0,
    });
  }, [
    backgroundUploadActive,
    failedHold,
    input.createJobPlan,
    input.appendActive,
    input.encodeBusy,
    input.createUploading,
    input.status,
    input.cancelRequested,
    input.createFailed,
    hasCompletionState,
    stage,
  ]);

  useEffect(() => {
    if (!createPipelineBase) return;
    const uploadPhase =
      Boolean(input.createUploading) || backgroundUploadActive;
    setCreateReachedIndex((prev) => {
      const next = Math.max(prev, createPipelineBase.activeIndex);
      // If Upload is active, never keep a stale lock on Fertig from
      // create_job's early "Vorgang fertig" event.
      if (
        uploadPhase &&
        createPipelineBase.steps.some((s) => s.id === "upload")
      ) {
        const uploadIdx = createPipelineBase.steps.findIndex(
          (s) => s.id === "upload",
        );
        if (uploadIdx >= 0 && next > uploadIdx && !createPipelineBase.completed) {
          return uploadIdx;
        }
      }
      return next;
    });
  }, [createPipelineBase, input.createUploading, backgroundUploadActive]);

  const createPipeline = useMemo((): CreateJobPipelineView | null => {
    if (!createPipelineBase) return null;
    let activeIndex = Math.max(
      createPipelineBase.activeIndex,
      createReachedIndex,
    );
    const uploadPhase =
      Boolean(input.createUploading) || backgroundUploadActive;
    if (
      uploadPhase &&
      !createPipelineBase.completed &&
      !createPipelineBase.cancelled &&
      !createPipelineBase.failed
    ) {
      const uploadIdx = createPipelineBase.steps.findIndex(
        (s) => s.id === "upload",
      );
      if (uploadIdx >= 0) activeIndex = uploadIdx;
    }
    return {
      ...createPipelineBase,
      activeIndex,
    };
  }, [
    createPipelineBase,
    createReachedIndex,
    input.createUploading,
    backgroundUploadActive,
  ]);

  // Keep the overall % bar together with the create stepper.
  const hideOverallBar = false;

  let snapshot: WorkflowProgressSnapshot | null = null;
  const uploadActive = Boolean(
    input.uploadProgress &&
      (input.createUploading || input.appendUploading || backgroundUploadActive),
  );
  if (
    input.encodeBusy ||
    input.appendActive ||
    input.createUploading ||
    backgroundUploadActive ||
    failedHold
  ) {
    if (uploadActive && input.uploadProgress) {
      snapshot = formatUploadProgressSnapshot(input.uploadProgress);
    } else if (
      (input.createUploading || backgroundUploadActive || failedHold) &&
      !input.encodeBusy
    ) {
      snapshot = {
        percent: failedHold ? input.percent : input.percent,
        label: formatOverallProgressLabel(
          input.status,
          failedHold
            ? tr("workflow.upload.failedHold")
            : tr("app.upload.title"),
        ),
      };
    } else {
      snapshot = {
        percent: input.percent,
        label: formatOverallProgressLabel(
          input.status,
          input.encodeBusy || input.appendActive
            ? tr("common.status.inProgress")
            : tr("common.status.done"),
        ),
      };
    }
  } else if (showSdProgress && sdProgress) {
    snapshot = sdProgress;
  } else if (showManualImport && manualImportProgress) {
    snapshot = manualImportProgress;
  } else if (showManualQr && manualQrProgress) {
    snapshot = manualQrProgress;
  } else if (showEncodeProgress) {
    snapshot = {
      percent: input.percent,
      label: formatOverallProgressLabel(
        input.status,
        input.encodeBusy ? tr("common.status.inProgress") : tr("common.status.done"),
      ),
    };
  }

  const tasks: WorkflowTaskProgress[] =
    input.encodeBusy ||
    input.appendActive ||
    (!showSdProgress && !showManualImport && !showManualQr && showEncodeProgress)
      ? input.taskProgress.map((t) => ({
          taskId: t.taskId,
          percent: t.percent,
          label: taskProgressLabel(t.taskId, t.status),
          status: t.status,
        }))
      : [];

  const encodeLabel = formatOverallProgressLabel(
    input.status,
    input.encodeBusy ? tr("common.status.inProgress") : tr("common.status.done"),
  );

  const sdClearing = input.sdWorkflowActive && input.sdPhase === "clearing";
  const canCancel =
    !sdClearing &&
    !failedHold &&
    (input.encodeBusy ||
      input.appendActive ||
      input.qrScanBusy ||
      input.sdWorkflowActive ||
      input.videoImporting ||
      input.photoImporting ||
      Boolean(input.createUploading) ||
      backgroundUploadActive);

  const showBackgroundChrome = backgroundUploadActive || failedHold;
  const effectiveCollapsed = showBackgroundChrome
    ? collapsed
    : collapsed && !isActive;

  const uploadCompact = formatUploadCompactParts(
    showBackgroundChrome ? input.uploadProgress : null,
  );

  function onToggleCollapsed() {
    // Manual expand/collapse: clear Success-Close auto-shrink; do not re-arm.
    clearAutoShrinkTimer();
    setCollapsed((prev) => !prev);
  }

  function onDismissFailedHold() {
    setFailedHold(false);
    setDismissed(true);
    setCollapsed(false);
    wasActiveRef.current = false;
  }

  return {
    visible: shouldShowPanel,
    collapsed: effectiveCollapsed,
    stage,
    subtitle,
    snapshot,
    tasks,
    encodeLabel,
    canCancel,
    cancelling,
    reserveSpace:
      shouldShowPanel &&
      (!effectiveCollapsed || showBackgroundChrome),
    createPipeline,
    hideOverallBar,
    backgroundUpload: showBackgroundChrome,
    uploadQueueCount,
    uploadCancelPhase: input.uploadCancelPhase ?? null,
    uploadCompact,
    uploadFailedHold: failedHold,
    onToggleCollapsed,
    onDismissFailedHold,
  };
}
