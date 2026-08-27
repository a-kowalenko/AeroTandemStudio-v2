import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Film, ImageIcon, Loader2 } from "lucide-react";
import { MediaDropZone } from "../MediaDropZone";
import { MediaListPanel } from "../MediaListPanel";
import { VideoPreview } from "../VideoPreview";
import { PhotoPreview } from "../PhotoPreview";
import { WorkflowProgressPanel } from "../WorkflowProgressPanel";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useVideoStore } from "../../store/videoStore";
import { usePhotoStore } from "../../store/photoStore";
import { useUiStore } from "../../store/uiStore";
import { useSdStore } from "../../store/sdStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { useAppendStore } from "../../store/appendStore";
import { useServerStore } from "../../store/serverStore";
import { useUploadQueueStore } from "../../store/uploadQueueStore";
import { deleteWorkingCopies, discardVideoCutUndoForPath } from "../../lib/tauri";
import { toUploadQueueJobPreview } from "../../lib/uploadQueue";
import { useWorkflowProgress } from "../../hooks/useWorkflowProgress";
import { useButtonActionPhaseKind } from "../../hooks/useTimedFlash";
import type { useVideoCutApply } from "../../hooks/useVideoCutApply";
import type { usePhotoEditApply } from "../../hooks/usePhotoEditApply";
import type { useCreateValidation } from "../../hooks/useCreateValidation";
import type { TaskProgressState } from "./types";
import type { CreateJobPlan } from "../../lib/createJobPlan";
import { cn } from "../../lib/utils";

type CreateValidation = ReturnType<typeof useCreateValidation>;
type VideoCuts = ReturnType<typeof useVideoCutApply>;
type PhotoEdits = ReturnType<typeof usePhotoEditApply>;

type Props = {
  busy: boolean;
  appendActive: boolean;
  sdWorkflowUiActive: boolean;
  cutterOpen: boolean;
  mediaTab: "video" | "foto";
  setMediaTab: (tab: "video" | "foto") => void;
  percent: number;
  status: string;
  taskProgress: TaskProgressState[];
  createJobPlan?: CreateJobPlan | null;
  createFailed?: boolean;
  /** CreateSuccessDialog open — used to trigger Auto-Shrink on close. */
  createSuccessOpen?: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatus: (status: string) => void;
  onProgressReset: () => void;
  onProgressComplete: (finalStatus: string) => void;
  /** Cancel session work (encode / SD / QR / import) — not upload slot. */
  onCancelSession: () => void;
  /** Cancel background upload slot only. */
  onCancelUpload: () => void;
  onResetProgress: () => void;
  onOpenCutter: (path: string, durationSecs: number) => void;
  onOpenPhotoEditor: (path: string) => void;
  onSessionCleared: () => void;
  createValidation: CreateValidation;
  videoCuts: VideoCuts;
  photoEdits: PhotoEdits;
};

export function WorkflowLayout({
  busy,
  appendActive,
  sdWorkflowUiActive,
  cutterOpen,
  mediaTab,
  setMediaTab,
  percent,
  status,
  taskProgress,
  createJobPlan = null,
  createFailed = false,
  createSuccessOpen = false,
  onBusyChange,
  onStatus,
  onProgressReset,
  onProgressComplete,
  onCancelSession,
  onCancelUpload,
  onResetProgress,
  onOpenCutter,
  onOpenPhotoEditor,
  onSessionCleared,
  createValidation,
  videoCuts,
  photoEdits,
}: Props) {
  const { t } = useTranslation();
  const [sessionCancelRequested, setSessionCancelRequested] = useState(false);
  const [uploadCancelRequested, setUploadCancelRequested] = useState(false);
  const [successCloseGeneration, setSuccessCloseGeneration] = useState(0);
  const prevSuccessOpenRef = useRef(createSuccessOpen);
  const videoList = useVideoStore((s) => s.videoList);
  const photoList = usePhotoStore((s) => s.photoList);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const loadingMessage = useUiStore((s) => s.loadingMessage);
  const loading = useUiStore((s) => s.loading);
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
  const appendGuest = useAppendStore((s) => s.context?.guest ?? null);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const uploadSlotActive = useUploadQueueStore((s) => s.active !== null);
  const uploadActiveId = useUploadQueueStore((s) => s.active?.id ?? null);
  const uploadGuestLabel = useUploadQueueStore(
    (s) => s.active?.guestLabel ?? null,
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

  const { createReady, createHints } = createValidation;

  const { phase: clearPhase, run: runClear } = useButtonActionPhaseKind<
    "video" | "foto"
  >();
  const clearBusy = clearPhase?.kind === mediaTab;
  const clearLoading = clearPhase?.kind === mediaTab && clearPhase.state === "loading";
  const clearDone = clearPhase?.kind === mediaTab && clearPhase.state === "done";

  const uiLocked =
    busy ||
    appendActive ||
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

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
    videoImporting,
    photoImporting,
    encodeBusy: busy,
    appendActive,
    appendGuest,
    appendUploading: false,
    backgroundUploadActive: uploadSlotHasWork,
    uploadGuestLabel,
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
  });

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

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
        style={
          stackPadPx > 0
            ? { paddingBottom: `calc(1rem + ${stackPadPx}px)` }
            : undefined
        }
      >
        <MediaDropZone
          disabled={uiLocked}
          onRemoveVideo={(path) => {
            useVideoStore.getState().clearCutMarksFor([path]);
            void discardVideoCutUndoForPath(path);
          }}
          onSessionCleared={onSessionCleared}
          onImported={({ videosAdded, photosAdded }) => {
            if (photosAdded > 0 && videosAdded === 0) setMediaTab("foto");
            else if (videosAdded > 0) setMediaTab("video");
          }}
        />

        <section className="ats-surface rounded-xl shadow-sm backdrop-blur-sm">
          <Tabs
            value={mediaTab}
            onValueChange={(v) => setMediaTab(v === "foto" ? "foto" : "video")}
            className="w-full"
          >
            <div className="flex flex-wrap items-center gap-3 rounded-t-xl border-b border-border/70 bg-card-elevated/50 px-3 py-2.5 sm:px-4">
              <TabsList
                className="h-11 w-full max-w-md flex-1 p-1 sm:w-auto"
                aria-label={t("app.media.kindAria")}
              >
                <TabsTrigger
                  value="video"
                  className="h-full flex-1 gap-2 px-4 data-[state=active]:text-primary"
                >
                  <Film className="h-4 w-4 shrink-0" aria-hidden />
                  <span>{t("common.labels.video")}</span>
                  {videoList.length > 0 && (
                    <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs tabular-nums text-muted">
                      {videoList.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="foto"
                  className="h-full flex-1 gap-2 px-4 data-[state=active]:text-primary"
                >
                  <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />
                  <span>{t("common.labels.photo")}</span>
                  {photoList.length > 0 && (
                    <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs tabular-nums text-muted">
                      {photoList.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className={cn(
                    "text-xs",
                    clearDone
                      ? "border-success/30 bg-success/10 text-success hover:bg-success/10 hover:text-success"
                      : clearLoading
                        ? "border-border text-muted"
                        : !(
                            uiLocked ||
                            (mediaTab === "video"
                              ? videoList.length === 0
                              : photoList.length === 0)
                          ) &&
                          "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                  )}
                  disabled={
                    uiLocked ||
                    clearBusy ||
                    (mediaTab === "video"
                      ? videoList.length === 0
                      : photoList.length === 0)
                  }
                  aria-busy={clearLoading}
                  onClick={() => {
                    if (mediaTab === "video") {
                      void runClear("video", async () => {
                        const paths = useVideoStore
                          .getState()
                          .videoList.map((v) => v.path);
                        useVideoStore.getState().clearVideos({ deleteFiles: false });
                        videoCuts.clearUndoState();
                        if (paths.length > 0) await deleteWorkingCopies(paths);
                        return true;
                      });
                    } else {
                      void runClear("foto", async () => {
                        const paths = usePhotoStore
                          .getState()
                          .photoList.map((p) => p.path);
                        usePhotoStore.getState().clearPhotos({ deleteFiles: false });
                        if (paths.length > 0) await deleteWorkingCopies(paths);
                        return true;
                      });
                    }
                  }}
                >
                  {clearLoading ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      {mediaTab === "video"
                        ? t("app.media.clearingVideos")
                        : t("app.media.clearingPhotos")}
                    </span>
                  ) : clearDone ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      {mediaTab === "video"
                        ? t("app.media.clearedVideos")
                        : t("app.media.clearedPhotos")}
                    </span>
                  ) : mediaTab === "video" ? (
                    t("app.media.clearVideos")
                  ) : (
                    t("app.media.clearPhotos")
                  )}
                </Button>
              </div>
            </div>
            <TabsContent value="video" className="mt-0 space-y-4 p-4">
              <VideoPreview
                busy={busy || sdWorkflowUiActive}
                onBusyChange={onBusyChange}
                onStatus={onStatus}
                percent={percent}
                status={status}
                taskProgress={taskProgress}
                onProgressReset={onProgressReset}
                onProgressComplete={onProgressComplete}
                formReady={createReady}
                formHints={createHints}
                playbackSuspended={cutterOpen || busy}
                canUndoCuts={videoCuts.canUndo}
                onUndoAllCuts={() => {
                  void videoCuts.undoAll({
                    onBusyChange,
                    onProgressReset,
                    onStatus,
                  });
                }}
                onUndoClipCut={(path) => {
                  void videoCuts.undoForPath(path, {
                    onBusyChange,
                    onProgressReset,
                    onStatus,
                  });
                }}
                onCutClip={(path) => {
                  const meta = videoList.find((v) => v.path === path);
                  onOpenCutter(path, meta?.duration_secs ?? 0);
                }}
                onBeforeRemoveClip={(path) => {
                  useVideoStore.getState().clearCutMarksFor([path]);
                  void discardVideoCutUndoForPath(path);
                }}
              />
              <MediaListPanel
                disabled={uiLocked}
                onRemoveVideo={(path) => {
                  useVideoStore.getState().clearCutMarksFor([path]);
                  void discardVideoCutUndoForPath(path);
                }}
                onCutVideo={(path) => {
                  const meta = videoList.find((v) => v.path === path);
                  onOpenCutter(path, meta?.duration_secs ?? 0);
                  setMediaTab("video");
                }}
                onUndoVideoCut={(path) => {
                  void videoCuts.undoForPath(path, {
                    onBusyChange,
                    onProgressReset,
                    onStatus,
                  });
                }}
              />            </TabsContent>
            <TabsContent value="foto" className="mt-0 space-y-4 p-4">
              <PhotoPreview
                disabled={uiLocked}
                onEditPhoto={onOpenPhotoEditor}
                onUndoPhotoEdit={(path) => {
                  void photoEdits.undoForPath(path, {
                    onBusyChange,
                    onProgressReset,
                    onStatus,
                  });
                }}
                onBatchRotate={(paths, degrees) => {
                  void photoEdits.applyRotateMany(paths, degrees, {
                    onBusyChange,
                    onProgressReset,
                    onStatus,
                  });
                }}
              />
            </TabsContent>
          </Tabs>
        </section>
      </div>

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
    </main>
  );
}
