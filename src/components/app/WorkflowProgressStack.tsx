import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WorkflowProgressPanel } from "../WorkflowProgressPanel";
import { useVideoStore } from "../../store/videoStore";
import { usePhotoStore } from "../../store/photoStore";
import { useUiStore } from "../../store/uiStore";
import { useSdStore } from "../../store/sdStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { useAppendStore } from "../../store/appendStore";
import { useServerStore } from "../../store/serverStore";
import { useUploadQueueStore } from "../../store/uploadQueueStore";
import { useProgressStore } from "../../store/progressStore";
import { useSessionRunStore } from "../../store/sessionRunStore";
import { toUploadQueueJobPreview } from "../../lib/uploadQueue";
import { useWorkflowProgress } from "../../hooks/useWorkflowProgress";

type Props = {
  busy: boolean;
  appendActive: boolean;
  sdWorkflowUiActive: boolean;
  createFailed: boolean;
  /** CreateSuccessDialog open — used to trigger Auto-Shrink on close. */
  createSuccessOpen: boolean;
  /** Cancel session work (encode / SD / QR / import) — not upload slot. */
  onCancelSession: () => void;
  /** Cancel background upload slot only. */
  onCancelUpload: () => void;
  onResetProgress: () => void;
  /** Bottom padding the media area needs so the overlay does not cover it. */
  onStackPadChange: (px: number) => void;
};

/**
 * Floating session + upload progress panels. Owns all high-frequency progress
 * subscriptions so ticks do not re-render the media workflow around it.
 */
export function WorkflowProgressStack({
  busy,
  appendActive,
  sdWorkflowUiActive,
  createFailed,
  createSuccessOpen,
  onCancelSession,
  onCancelUpload,
  onResetProgress,
  onStackPadChange,
}: Props) {
  const [sessionCancelRequested, setSessionCancelRequested] = useState(false);
  const [uploadCancelRequested, setUploadCancelRequested] = useState(false);
  const [successCloseGeneration, setSuccessCloseGeneration] = useState(0);
  const prevSuccessOpenRef = useRef(createSuccessOpen);
  const percent = useProgressStore((s) => s.percent);
  const status = useProgressStore((s) => s.status);
  const taskProgress = useProgressStore((s) => s.taskProgress);
  const createJobPlan = useProgressStore((s) => s.createJobPlan);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const loadingMessage = useUiStore((s) => s.loadingMessage);
  const sdPhase = useSdStore((s) => s.phase);
  const backupProgress = useSdStore((s) => s.backupProgress);
  const workflowProgress = useSdStore((s) => s.workflowProgress);
  const qrScanBusy = useQrScanStore((s) => s.busy);
  const qrScanStage = useQrScanStore((s) => s.stage);
  const qrScanByPath = useQrScanStore((s) => s.byPath);
  const qrFollowup = useQrScanStore((s) => s.followup);
  const qrClipProgress = useQrScanStore((s) => s.clipProgress);
  const qrScanOrder = useQrScanStore((s) => s.scanOrder);
  const qrPhotoEdgeLimited = useQrScanStore((s) => s.photoEdgeLimited);
  const qrVideoEdgeLimited = useQrScanStore((s) => s.videoEdgeLimited);
  const sessionOutcome = useSessionRunStore((s) => s.outcome);
  const clearSessionRun = useSessionRunStore((s) => s.clearSessionRun);
  const appendGuest = useAppendStore((s) => s.context?.guest ?? null);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const uploadSlotActive = useUploadQueueStore((s) => s.active !== null);
  const uploadActiveId = useUploadQueueStore((s) => s.active?.id ?? null);
  const uploadActive = useUploadQueueStore((s) => s.active);
  const uploadActiveJob = useMemo(
    () => (uploadActive ? toUploadQueueJobPreview(uploadActive) : null),
    [uploadActive],
  );
  const uploadQueue = useUploadQueueStore((s) => s.queue);
  const uploadQueueLen = uploadQueue.length;
  const uploadQueueJobs = useMemo(
    () => uploadQueue.map(toUploadQueueJobPreview),
    [uploadQueue],
  );
  const uploadLastOutcome = useUploadQueueStore((s) => s.lastOutcome);
  const uploadCancelPhase = useUploadQueueStore((s) => s.cancelPhase);
  const uploadSlotHasWork = uploadSlotActive || uploadQueueLen > 0;
  const prevUploadActiveIdRef = useRef(uploadActiveId);

  const sessionCancellable =
    busy ||
    appendActive ||
    sdWorkflowUiActive ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  useEffect(() => {
    if (!sessionCancellable) setSessionCancelRequested(false);
  }, [sessionCancellable]);

  useEffect(() => {
    if (!uploadSlotHasWork) setUploadCancelRequested(false);
  }, [uploadSlotHasWork]);

  // Clear cancel chrome when the active slot job changes (next queued upload
  // after abort). Do not wait until the whole queue is empty.
  useEffect(() => {
    if (prevUploadActiveIdRef.current === uploadActiveId) return;
    prevUploadActiveIdRef.current = uploadActiveId;
    setUploadCancelRequested(false);
  }, [uploadActiveId]);

  // Success-Modal close → bump generation for Auto-Shrink (only while expanded).
  useEffect(() => {
    const wasOpen = prevSuccessOpenRef.current;
    prevSuccessOpenRef.current = createSuccessOpen;
    if (wasOpen && !createSuccessOpen && uploadSlotHasWork) {
      setSuccessCloseGeneration((n) => n + 1);
    }
  }, [createSuccessOpen, uploadSlotHasWork]);

  // Phase 37.4: upload panel tracks slot independently of session busy/append.
  const { session: sessionView, upload: uploadView } = useWorkflowProgress({
    sdWorkflowActive: sdWorkflowUiActive,
    sdPhase,
    backupProgress,
    workflowProgress,
    loadingMessage,
    qrScanBusy,
    qrScanStage,
    qrScanByPath,
    qrFollowup,
    qrClipProgress,
    qrScanOrder,
    qrPhotoEdgeLimited,
    qrVideoEdgeLimited,
    videoImporting,
    photoImporting,
    encodeBusy: busy,
    appendActive,
    appendGuest,
    appendUploading: false,
    backgroundUploadActive: uploadSlotHasWork,
    uploadActiveJob,
    uploadQueueCount: uploadQueueLen,
    uploadQueueJobs,
    uploadCancelPhase,
    successCloseGeneration,
    uploadLastOutcome,
    uploadProgress,
    percent,
    status,
    taskProgress,
    sessionCancelRequested,
    uploadCancelRequested,
    createJobPlan,
    createFailed,
    sessionOutcome,
    onDismissSessionOutcome: clearSessionRun,
  });

  useEffect(() => {
    if (busy || appendActive) clearSessionRun();
  }, [busy, appendActive, clearSessionRun]);

  useEffect(() => {
    if (busy || appendActive || uploadSlotHasWork) return;
    if (percent <= 0 && taskProgress.length === 0 && !status.trim()) return;
    if (sessionView.visible || uploadView.visible) return;
    onResetProgress();
  }, [
    busy,
    appendActive,
    uploadSlotHasWork,
    percent,
    taskProgress.length,
    status,
    sessionView.visible,
    uploadView.visible,
    onResetProgress,
  ]);

  /** Bottom padding ≈ stacked panel heights + gap (absolute overlay). */
  const stackPadPx =
    (sessionView.visible
      ? sessionView.collapsed
        ? 48
        : sessionView.createPipeline
          ? 176
          : 144
      : 0) +
    (uploadView.visible
      ? uploadView.collapsed
        ? 64
        : uploadView.createPipeline
          ? 176
          : 144
      : 0) +
    (sessionView.visible && uploadView.visible ? 8 : 0);

  useLayoutEffect(() => {
    onStackPadChange(stackPadPx);
  }, [stackPadPx, onStackPadChange]);

  function handleCancelSession() {
    if (sessionCancelRequested) return;
    setSessionCancelRequested(true);
    onCancelSession();
  }

  function handleCancelUpload() {
    if (uploadCancelRequested) return;
    setUploadCancelRequested(true);
    onCancelUpload();
  }

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex flex-col gap-2">
      <WorkflowProgressPanel
        view={sessionView}
        onCancel={handleCancelSession}
        className="mx-auto w-full max-w-2xl"
      />
      <WorkflowProgressPanel
        view={uploadView}
        onCancel={handleCancelUpload}
        className="mx-auto w-full max-w-2xl"
      />
    </div>
  );
}
