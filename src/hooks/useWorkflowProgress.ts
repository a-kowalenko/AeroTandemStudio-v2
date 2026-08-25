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
import { formatUploadProgressSnapshot } from "../lib/uploadProgress";
import type { UploadProgressEvent } from "../lib/tauri";
import {
  summarizeQrScanProgress,
  type QrClipFrameProgress,
  type QrFollowupStatus,
  type QrScanJobStage,
  type QrScanPhase,
} from "../store/qrScanStore";

const COLLAPSE_AFTER_MS = 3500;
const HIDE_AFTER_MS = 9000;

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
  const wasActiveRef = useRef(false);
  const [createReachedIndex, setCreateReachedIndex] = useState(0);
  const createPlanIdRef = useRef<CreateJobPlan | null>(null);

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

  const isActive =
    showSdProgress ||
    showManualImport ||
    showManualQr ||
    input.encodeBusy ||
    input.appendActive ||
    input.qrScanBusy;

  const hasCompletionState =
    !input.encodeBusy &&
    (input.percent > 0 || input.taskProgress.length > 0 || Boolean(input.status.trim()));

  const shouldShowPanel =
    !dismissed &&
    (isActive ||
      hasCompletionState ||
      showEncodeProgress);

  useEffect(() => {
    if (isActive) {
      wasActiveRef.current = true;
      setDismissed(false);
      setCollapsed(false);
      return;
    }

    if (!wasActiveRef.current || dismissed) return;

    const collapseTimer = window.setTimeout(() => {
      setCollapsed(true);
    }, COLLAPSE_AFTER_MS);

    const hideTimer = window.setTimeout(() => {
      setDismissed(true);
      setCollapsed(false);
      wasActiveRef.current = false;
    }, HIDE_AFTER_MS);

    return () => {
      window.clearTimeout(collapseTimer);
      window.clearTimeout(hideTimer);
    };
  }, [isActive, dismissed]);

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

  const cancelling = Boolean(input.cancelRequested && isActive);
  const subtitle = workflowStageSubtitle(stage, {
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

  const createPipelineBase = useMemo((): CreateJobPipelineView | null => {
    const plan = input.createJobPlan ?? null;
    if (!plan) return null;
    if (input.appendActive) return null;
    if (
      !input.encodeBusy &&
      !input.createUploading &&
      !hasCompletionState &&
      stage !== "create" &&
      stage !== "done"
    ) {
      return null;
    }

    const cancelled =
      Boolean(input.cancelRequested && !input.encodeBusy && !input.createUploading) ||
      /abgebrochen|cancelled/i.test(input.status.trim());

    return resolveCreateJobPipeline({
      plan,
      status: input.status,
      uploading: Boolean(input.createUploading),
      busy: input.encodeBusy || Boolean(input.createUploading),
      cancelled,
      failed: Boolean(input.createFailed),
      reachedIndex: 0,
    });
  }, [
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
    setCreateReachedIndex((prev) => {
      const next = Math.max(prev, createPipelineBase.activeIndex);
      // If Upload is active, never keep a stale lock on Fertig from
      // create_job's early "Vorgang fertig" event.
      if (
        input.createUploading &&
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
  }, [createPipelineBase, input.createUploading]);

  const createPipeline = useMemo((): CreateJobPipelineView | null => {
    if (!createPipelineBase) return null;
    let activeIndex = Math.max(
      createPipelineBase.activeIndex,
      createReachedIndex,
    );
    if (
      input.createUploading &&
      !createPipelineBase.completed &&
      !createPipelineBase.cancelled
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
  }, [createPipelineBase, createReachedIndex, input.createUploading]);

  // Keep the overall % bar together with the create stepper.
  const hideOverallBar = false;

  let snapshot: WorkflowProgressSnapshot | null = null;
  const uploadActive = Boolean(
    input.uploadProgress &&
      (input.createUploading || input.appendUploading),
  );
  if (input.encodeBusy || input.appendActive) {
    if (uploadActive && input.uploadProgress) {
      snapshot = formatUploadProgressSnapshot(input.uploadProgress);
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
    (input.encodeBusy ||
      input.appendActive ||
      input.qrScanBusy ||
      input.sdWorkflowActive ||
      input.videoImporting ||
      input.photoImporting);

  return {
    visible: shouldShowPanel,
    collapsed: collapsed && !isActive,
    stage,
    subtitle,
    snapshot,
    tasks,
    encodeLabel,
    canCancel,
    cancelling,
    reserveSpace: shouldShowPanel && !collapsed,
    createPipeline,
    hideOverallBar,
  };
}
