import { useEffect, useMemo, useRef, useState } from "react";
import type { BackupProgress, WorkflowProgress } from "../lib/sdCard";
import {
  formatOverallProgressLabel,
  taskProgressLabel,
} from "../lib/progressLabels";
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
  reserveSpace: boolean;
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
  videoImporting: boolean;
  photoImporting: boolean;
  encodeBusy: boolean;
  percent: number;
  status: string;
  taskProgress: TaskState[];
};

export function useWorkflowProgress(input: Input): WorkflowProgressView {
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const wasActiveRef = useRef(false);

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
    ],
  );

  const mediaImporting = input.videoImporting || input.photoImporting;
  const manualImportProgress = useMemo((): WorkflowProgressSnapshot | null => {
    if (input.sdWorkflowActive || input.qrScanBusy) return null;
    if (input.workflowProgress?.stage === "import") {
      return {
        percent: input.workflowProgress.percent,
        label: formatWorkflowLabel(input.workflowProgress, "Importiere…"),
        detail: formatWorkflowDetail(input.workflowProgress),
      };
    }
    if (mediaImporting) {
      return {
        percent: 0,
        label: "Importiere…",
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
    );
  }, [
    input.qrScanBusy,
    input.sdWorkflowActive,
    input.qrScanByPath,
    input.qrScanStage,
    input.qrFollowup,
    input.qrClipProgress,
    input.qrScanOrder,
  ]);

  const showSdProgress = Boolean(input.sdWorkflowActive && sdProgress);
  const showManualImport = Boolean(manualImportProgress);
  const showManualQr = Boolean(manualQrProgress);
  const showEncodeProgress =
    input.encodeBusy || input.percent > 0 || input.taskProgress.length > 0;

  const isActive =
    showSdProgress ||
    showManualImport ||
    showManualQr ||
    input.encodeBusy ||
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

  const stage = inferWorkflowStage({
    sdWorkflowActive: input.sdWorkflowActive,
    sdPhase: input.sdPhase,
    qrScanBusy: input.qrScanBusy,
    manualImport: showManualImport,
    manualQr: showManualQr,
    encodeBusy: input.encodeBusy,
    status: input.status,
    sdProgress,
  });

  const subtitle = workflowStageSubtitle(stage, {
    sdWorkflowActive: input.sdWorkflowActive,
    sdPhase: input.sdPhase,
    qrScanBusy: input.qrScanBusy,
    encodeBusy: input.encodeBusy,
    manualImport: showManualImport,
    manualQr: showManualQr,
  });

  let snapshot: WorkflowProgressSnapshot | null = null;
  if (input.encodeBusy) {
    snapshot = {
      percent: input.percent,
      label: formatOverallProgressLabel(
        input.status,
        input.encodeBusy ? "In Arbeit…" : "Fertig",
      ),
    };
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
        input.encodeBusy ? "In Arbeit…" : "Fertig",
      ),
    };
  }

  const tasks: WorkflowTaskProgress[] =
    input.encodeBusy || (!showSdProgress && !showManualImport && !showManualQr && showEncodeProgress)
      ? input.taskProgress.map((t) => ({
          taskId: t.taskId,
          percent: t.percent,
          label: taskProgressLabel(t.taskId, t.status),
          status: t.status,
        }))
      : [];

  const encodeLabel = formatOverallProgressLabel(
    input.status,
    input.encodeBusy ? "In Arbeit…" : "Fertig",
  );

  const sdClearing = input.sdWorkflowActive && input.sdPhase === "clearing";
  const canCancel =
    !sdClearing &&
    (input.encodeBusy ||
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
    reserveSpace: shouldShowPanel && !collapsed,
  };
}
