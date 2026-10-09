import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WorkflowProgressPanel } from "../WorkflowProgressPanel";
import { CreateOutcomeCard } from "../CreateOutcomeCard";
import { useCreateOutcomeStore } from "../../store/createOutcomeStore";
import { createOutcomeQueuePosition } from "../../lib/createRunOutcome";
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
  onCancelSession,
  onCancelUpload,
  onResetProgress,
  onStackPadChange,
}: Props) {
  const [sessionCancelRequested, setSessionCancelRequested] = useState(false);
  const [uploadCancelRequested, setUploadCancelRequested] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const createOutcome = useCreateOutcomeStore((s) => s.outcome);
  const clearCreateOutcome = useCreateOutcomeStore((s) => s.clearCreateOutcome);
  const prevBusyRef = useRef(busy);
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
  const qrLookup = useQrScanStore((s) => s.lookup);
  const qrNeighborFollowup = useQrScanStore((s) => s.liveAnchorKey != null);
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

  // Next create/append starts → previous report is stale.
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy && busy) clearCreateOutcome();
  }, [busy, clearCreateOutcome]);

  // Report rides in the upload panel while its upload is active/queued (or
  // about to be enqueued); otherwise it floats as its own card.
  const createOutcomeUploadBound = Boolean(
    createOutcome?.info.uploadJobId &&
      (uploadSlotHasWork || createOutcome.info.uploadInProgress),
  );
  const uploadDoneHold = Boolean(
    createOutcome?.info.uploadJobId &&
      createOutcome.info.serverUploaded &&
      !createOutcome.info.uploadInProgress &&
      !uploadSlotHasWork,
  );
  const embeddedCreateOutcome =
    createOutcome && (createOutcomeUploadBound || uploadDoneHold)
      ? createOutcome
      : null;
  const standaloneCreateOutcome =
    createOutcome && !embeddedCreateOutcome ? createOutcome : null;
  const createOutcomeQueuePos = createOutcomeQueuePosition(
    embeddedCreateOutcome?.info.uploadJobId,
    uploadActiveId,
    uploadQueue.map((j) => j.id),
  );

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
    qrLookup,
    qrNeighborFollowup,
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
    embeddedCreateOutcomeId: embeddedCreateOutcome?.id ?? null,
    createOutcomeActive: createOutcome !== null,
    uploadDoneHold,
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
    // Keep the create plan until the outcome card is gone (finished-upload steps).
    if (createOutcome) return;
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
    createOutcome,
    sessionView.visible,
    uploadView.visible,
    onResetProgress,
  ]);

  // Bottom padding = measured overlay height (cards vary with content).
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const report = () => onStackPadChange(Math.ceil(el.offsetHeight));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onStackPadChange]);

  function handleCreateOutcomeDone(id: number, embedded: boolean) {
    if (!embedded) {
      clearCreateOutcome(id);
      return;
    }
    // Hide with the panel. Data stays so expanding shows it again.
    uploadView.onAutoCollapse();
  }

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
    <div
      ref={stackRef}
      className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex flex-col gap-2"
    >
      {standaloneCreateOutcome ? (
        <CreateOutcomeCard
          key={standaloneCreateOutcome.id}
          outcome={standaloneCreateOutcome}
          variant="standalone"
          onDone={() => handleCreateOutcomeDone(standaloneCreateOutcome.id, false)}
          className="mx-auto w-full max-w-2xl"
        />
      ) : null}
      <WorkflowProgressPanel
        view={sessionView}
        onCancel={handleCancelSession}
        className="mx-auto w-full max-w-2xl"
      />
      <WorkflowProgressPanel
        view={uploadView}
        onCancel={handleCancelUpload}
        className="mx-auto w-full max-w-2xl"
        onUploadDone={
          uploadDoneHold && embeddedCreateOutcome
            ? () => clearCreateOutcome(embeddedCreateOutcome.id)
            : undefined
        }
        uploadOutcome={
          embeddedCreateOutcome ? (
            <CreateOutcomeCard
              key={embeddedCreateOutcome.id}
              outcome={embeddedCreateOutcome}
              variant="embedded"
              queuePosition={createOutcomeQueuePos}
              onDone={() => {
                if (uploadDoneHold) {
                  clearCreateOutcome(embeddedCreateOutcome.id);
                  return;
                }
                handleCreateOutcomeDone(embeddedCreateOutcome.id, true);
              }}
            />
          ) : null
        }
      />
    </div>
  );
}
