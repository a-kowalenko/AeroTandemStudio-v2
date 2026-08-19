import { useTranslation } from "react-i18next";
import { FolderClock, RotateCcw } from "lucide-react";
import { AppChrome } from "../chrome/AppChrome";
import { ServerStatusIndicator } from "../ServerStatusIndicator";
import { SdModeSelector } from "../SdModeSelector";
import { SdDriveSelector } from "../SdDriveSelector";
import { SettingsCluster } from "../SettingsCluster";
import { LogConsole } from "../LogConsole";
import { Button } from "../ui/button";
import { useConfigStore } from "../../store/configStore";
import { useSdStore } from "../../store/sdStore";
import { useAppendStore } from "../../store/appendStore";
import { usePhotoStore } from "../../store/photoStore";
import { useVideoStore } from "../../store/videoStore";
import { useUiStore } from "../../store/uiStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { useCreateValidation } from "../../hooks/useCreateValidation";
import type { HwAccelInfo } from "../../lib/tauri";
import type { useVideoCutApply } from "../../hooks/useVideoCutApply";
import type { usePhotoEditApply } from "../../hooks/usePhotoEditApply";
import { CustomerSidebar } from "./CustomerSidebar";
import { WorkflowLayout } from "./WorkflowLayout";
import type { TaskProgressState } from "./types";

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
  cutterOpen: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatus: (status: string) => void;
  onProgressReset: () => void;
  onProgressComplete: (finalStatus: string) => void;
  onCancel: () => void;
  onResetProgress: () => void;
  onOpenCutter: (path: string, durationSecs: number) => void;
  onOpenPhotoEditor: (path: string) => void;
  onStartCreate: () => void;
  onEnsureSpeicherort: (forcePick?: boolean) => Promise<string | null>;
  onOpenSpeicherortFolder: () => void;
  onOpenSdDrive: (drive: string) => void;
  onSdPrimaryAction: (drive: string) => void;
  onOpenHistory: () => void;
  onSessionReset: () => void;
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
  cutterOpen,
  onBusyChange,
  onStatus,
  onProgressReset,
  onProgressComplete,
  onCancel,
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
  const secondaryBackup = useSdStore((s) => s.secondaryBackup);
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
              title={t("app.chrome.historyTitle")}
            >
              <FolderClock className="h-4 w-4" />
              <span className="hidden sm:inline">{t("common.actions.history")}</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onSessionReset}
              disabled={uiLocked || !ready}
              title={t("app.chrome.resetTitle")}
              className="border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("common.actions.reset")}</span>
            </Button>
            <SettingsCluster
              disabled={!ready}
              onOpenSettings={onOpenSettings}
            />
          </>
        }
      >
        <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-primary-soft ring-1 ring-primary/20">
            <img
              src="/logo.png"
              alt=""
              className="h-[22px] w-[22px] object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
          <div className="flex min-h-[34px] min-w-0 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-baseline gap-x-1.5">
              <h1 className="font-display truncate text-base font-semibold leading-none tracking-tight text-primary">
                Aero Tandem Studio
              </h1>
              <span className="shrink-0 text-[11px] leading-none text-muted">
                v{appVersion}
              </span>
            </div>
            <p className="truncate text-[10px] leading-none text-muted">
              {secondaryBackup &&
              (secondaryBackup.state === "started" ||
                secondaryBackup.state === "progress")
                ? `${t("app.chrome.serverBackupPercent", { percent: Math.round(secondaryBackup.percent) })}` +
                  (secondaryBackup.file_name
                    ? ` · ${secondaryBackup.file_name}`
                    : "")
                : secondaryBackup?.state === "done"
                  ? t("app.chrome.serverBackupDone")
                  : hwLabel
                    ? t("app.chrome.encoder", { label: hwLabel })
                    : ready
                      ? t("app.chrome.ready")
                      : t("app.chrome.starting")}
            </p>
          </div>
        </div>
      </AppChrome>

      <div className="flex min-h-0 flex-1 flex-col">
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
            onBusyChange={onBusyChange}
            onStatus={onStatus}
            onProgressReset={onProgressReset}
            onProgressComplete={onProgressComplete}
            onCancel={onCancel}
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
