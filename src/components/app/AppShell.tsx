import { useTranslation } from "react-i18next";
import { Check, FolderClock, Loader2, RotateCcw } from "lucide-react";
import { AppChrome } from "../chrome/AppChrome";
import { HeaderBrand } from "../chrome/HeaderBrand";
import { ServerStatusIndicator } from "../ServerStatusIndicator";
import { SdModeSelector } from "../SdModeSelector";
import { SdDriveSelector } from "../SdDriveSelector";
import { SettingsCluster } from "../SettingsCluster";
import { LogConsole } from "../LogConsole";
import { Button } from "../ui/button";
import { useConfigStore } from "../../store/configStore";
import { useAppendStore } from "../../store/appendStore";
import { usePhotoStore } from "../../store/photoStore";
import { useVideoStore } from "../../store/videoStore";
import { useUiStore } from "../../store/uiStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { useHistoryStore } from "../../store/historyStore";
import { useCreateValidation } from "../../hooks/useCreateValidation";
import { useButtonActionPhase } from "../../hooks/useTimedFlash";
import type { HwAccelInfo } from "../../lib/tauri";
import type { useVideoCutApply } from "../../hooks/useVideoCutApply";
import type { usePhotoEditApply } from "../../hooks/usePhotoEditApply";
import { CustomerSidebar } from "./CustomerSidebar";
import { WorkflowLayout } from "./WorkflowLayout";
import { AppPathHintsDriftBanner } from "./AppPathHintsDriftBanner";
import type { TaskProgressState } from "./types";
import type { CreateJobPlan } from "../../lib/createJobPlan";
import { cn } from "../../lib/utils";

type VideoCuts = ReturnType<typeof useVideoCutApply>;
type PhotoEdits = ReturnType<typeof usePhotoEditApply>;

export type AppShellProps = {
  ready: boolean;
  appVersion: string;
  hwInfo: HwAccelInfo | null;
  busy: boolean;
  sdWorkflowUiActive: boolean;
  mediaTab: "video" | "foto";
  setMediaTab: (tab: "video" | "foto") => void;
  percent: number;
  status: string;
  taskProgress: TaskProgressState[];
  createJobPlan?: CreateJobPlan | null;
  createFailed?: boolean;
  createSuccessOpen?: boolean;
  cutterOpen: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatus: (status: string) => void;
  onProgressReset: () => void;
  onProgressComplete: (finalStatus: string) => void;
  onCancelSession: () => void;
  onCancelUpload: () => void;
  onResetProgress: () => void;
  onOpenCutter: (path: string, durationSecs: number) => void;
  onOpenPhotoEditor: (path: string) => void;
  onStartCreate: () => void;
  onEnsureSpeicherort: (forcePick?: boolean) => Promise<string | null>;
  onOpenSpeicherortFolder: () => void;
  onOpenSdDrive: (drive: string) => void;
  onSdPrimaryAction: (drive: string) => void;
  onOpenHistory: () => void;
  onSessionReset: () => boolean | Promise<boolean>;
  onOpenSettings: () => void;
  onSessionCleared: () => void;
  videoCuts: VideoCuts;
  photoEdits: PhotoEdits;
};

export function AppShell({
  ready,
  appVersion,
  hwInfo,
  busy,
  sdWorkflowUiActive,
  mediaTab,
  setMediaTab,
  percent,
  status,
  taskProgress,
  createJobPlan = null,
  createFailed = false,
  createSuccessOpen = false,
  cutterOpen,
  onBusyChange,
  onStatus,
  onProgressReset,
  onProgressComplete,
  onCancelSession,
  onCancelUpload,
  onResetProgress,
  onOpenCutter,
  onOpenPhotoEditor,
  onStartCreate,
  onEnsureSpeicherort,
  onOpenSpeicherortFolder,
  onOpenSdDrive,
  onSdPrimaryAction,
  onOpenHistory,
  onSessionReset,
  onOpenSettings,
  onSessionCleared,
  videoCuts,
  photoEdits,
}: AppShellProps) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const uploadToServer = Boolean(config?.upload_to_server);
  const pendingUploadCount = useHistoryStore((s) => s.pendingUploadCount);
  const appendActive = useAppendStore((s) => s.active);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const loading = useUiStore((s) => s.loading);
  const qrScanBusy = useQrScanStore((s) => s.busy);

  const uiLocked =
    busy ||
    appendActive ||
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  const pipelineActive =
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  const createValidation = useCreateValidation({
    ready,
    busy,
    pipelineActive,
    uiLocked,
  });

  const { phase: resetPhase, run: runReset } = useButtonActionPhase();

  const hwLabel = hwInfo
    ? `${hwInfo.encoder}${hwInfo.available ? "" : t("app.chrome.softwareSuffix")}`
    : null;

  return (
    <>
      <AppChrome
        actions={
          <>
            <SdDriveSelector
              disabled={uiLocked || !ready}
              onOpenDrive={onOpenSdDrive}
              onPrimaryAction={onSdPrimaryAction}
            />
            <SdModeSelector
              visible={Boolean(config?.sd_auto_backup)}
              disabled={uiLocked}
            />
            <ServerStatusIndicator />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onOpenHistory}
              disabled={busy || !ready}
              title={
                uploadToServer && pendingUploadCount > 0
                  ? t("history.upload.pendingBadgeTooltip", {
                      count: pendingUploadCount,
                    })
                  : t("app.chrome.historyTitle")
              }
              className="relative"
            >
              <FolderClock className="h-4 w-4" />
              <span className="hidden sm:inline">{t("common.actions.history")}</span>
              {uploadToServer && pendingUploadCount > 0 ? (
                <span
                  className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
                  aria-hidden
                >
                  {pendingUploadCount > 99 ? "99+" : pendingUploadCount}
                </span>
              ) : null}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void runReset(() => onSessionReset());
              }}
              disabled={uiLocked || !ready || resetPhase !== "idle"}
              title={t("app.chrome.resetTitle")}
              aria-busy={resetPhase === "loading"}
              className={cn(
                resetPhase === "done"
                  ? "border-success/30 bg-success/10 text-success hover:bg-success/10 hover:text-success"
                  : resetPhase === "loading"
                    ? "border-border bg-card text-muted"
                    : "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
              )}
            >
              {resetPhase === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : resetPhase === "done" ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="hidden sm:inline">
                {resetPhase === "loading"
                  ? t("app.session.resetting")
                  : resetPhase === "done"
                    ? t("app.session.resetFlash")
                    : t("common.actions.reset")}
              </span>
            </Button>
            <SettingsCluster
              disabled={!ready}
              onOpenSettings={onOpenSettings}
            />
          </>
        }
      >
        <HeaderBrand
          appVersion={appVersion}
          ready={ready}
          hwLabel={hwLabel}
        />
      </AppChrome>

      <div className="flex min-h-0 flex-1 flex-col">
        <AppPathHintsDriftBanner />
        <div className="flex min-h-0 flex-1">
          <CustomerSidebar
            busy={busy}
            appendActive={appendActive}
            sdWorkflowUiActive={sdWorkflowUiActive}
            pipelineActive={pipelineActive}
            onStartCreate={onStartCreate}
            setMediaTab={setMediaTab}
            createValidation={createValidation}
            onEnsureSpeicherort={onEnsureSpeicherort}
            onOpenSpeicherortFolder={onOpenSpeicherortFolder}
          />
          <WorkflowLayout
            busy={busy}
            appendActive={appendActive}
            sdWorkflowUiActive={sdWorkflowUiActive}
            cutterOpen={cutterOpen}
            mediaTab={mediaTab}
            setMediaTab={setMediaTab}
            percent={percent}
            status={status}
            taskProgress={taskProgress}
            createJobPlan={createJobPlan}
            createFailed={createFailed}
            createSuccessOpen={createSuccessOpen}
            onBusyChange={onBusyChange}
            onStatus={onStatus}
            onProgressReset={onProgressReset}
            onProgressComplete={onProgressComplete}
            onCancelSession={onCancelSession}
            onCancelUpload={onCancelUpload}
            onResetProgress={onResetProgress}
            onOpenCutter={onOpenCutter}
            onOpenPhotoEditor={onOpenPhotoEditor}
            onSessionCleared={onSessionCleared}
            createValidation={createValidation}
            videoCuts={videoCuts}
            photoEdits={photoEdits}
          />
        </div>
        <LogConsole />
      </div>
    </>
  );
}
