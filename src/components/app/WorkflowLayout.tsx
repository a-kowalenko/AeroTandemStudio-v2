import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Film, ImageIcon, Loader2 } from "lucide-react";
import { MediaDropZone } from "../MediaDropZone";
import { MediaListPanel } from "../MediaListPanel";
import { VideoPreview } from "../VideoPreview";
import { PhotoPreview } from "../PhotoPreview";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useVideoStore } from "../../store/videoStore";
import { usePhotoStore } from "../../store/photoStore";
import { useUiStore } from "../../store/uiStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { deleteWorkingCopies, discardVideoCutUndoForPath } from "../../lib/tauri";
import { useButtonActionPhaseKind } from "../../hooks/useTimedFlash";
import type { useVideoCutApply } from "../../hooks/useVideoCutApply";
import type { usePhotoEditApply } from "../../hooks/usePhotoEditApply";
import type { useCreateValidation } from "../../hooks/useCreateValidation";
import { cn } from "../../lib/utils";
import { WorkflowProgressStack } from "./WorkflowProgressStack";

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
  const [stackPadPx, setStackPadPx] = useState(0);
  const videoList = useVideoStore((s) => s.videoList);
  const photoList = usePhotoStore((s) => s.photoList);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const loading = useUiStore((s) => s.loading);
  const qrScanBusy = useQrScanStore((s) => s.busy);

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

      <WorkflowProgressStack
        busy={busy}
        appendActive={appendActive}
        sdWorkflowUiActive={sdWorkflowUiActive}
        createFailed={createFailed}
        createSuccessOpen={createSuccessOpen}
        onCancelSession={onCancelSession}
        onCancelUpload={onCancelUpload}
        onResetProgress={onResetProgress}
        onStackPadChange={setStackPadPx}
      />
    </main>
  );
}
