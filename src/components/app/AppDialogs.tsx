import { Suspense } from "react";
import type { AvailableRelease, UpdateInstallProgress } from "../../lib/tauri";
import type { SdWorkflowActions } from "../../lib/sdCard";
import type { IntroMuxFallbackChoice } from "../IntroMuxFallbackDialog";
import type { BodyConcatFallbackChoice } from "../BodyConcatFallbackDialog";
import type { CreateSuccessInfo } from "../CreateSuccessDialog";
import type { PhotoEditorResult } from "../PhotoEditor";
import type { VideoCutterResult } from "../VideoCutter";
import { ErrorDialog } from "../ErrorDialog";
import { SuccessDialog } from "../SuccessDialog";
import { CreateSuccessDialog } from "../CreateSuccessDialog";
import { WarningDialog } from "../WarningDialog";
import { IntroMuxFallbackDialog } from "../IntroMuxFallbackDialog";
import { BodyConcatFallbackDialog } from "../BodyConcatFallbackDialog";
import { LoadingOverlay } from "../LoadingOverlay";
import { ToastHost } from "../ToastHost";
import { UpdateDialog } from "../UpdateDialog";
import type {
  DialogActionStatus,
  DialogChoicesOptions,
  DialogConfirmOptions,
  DialogKind,
  DialogPrimaryAction,
  DialogVariant,
  SettingsTab,
  SettingsFocusTarget,
} from "../../store/uiStore";
import type { AppConfig } from "../../lib/tauri";
import type { QrPreview } from "../../lib/tauri";
import {
  LazyHistoryDialog,
  LazyPhotoEditor,
  LazySdFileSelector,
  LazySettingsDialog,
  LazySetupWizard,
  LazyVideoCutter,
} from "./lazyDialogs";

export type AppDialogsProps = {
  config: AppConfig | null;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setupWizardOpen: boolean;
  onSetupComplete: () => void;
  updateDialogOpen: boolean;
  versionInstall: {
    fromVersion: string;
    toVersion: string | null;
    notes: string | null;
    available: boolean;
    message: string;
    updaterJsonUrl: string | null;
    silentAvailable: boolean;
    installerUrl: string | null;
  } | null;
  appVersion: string;
  updateInstalling: boolean;
  updateInstallProgress: UpdateInstallProgress | null;
  installBlockedReason: string | null;
  updaterPlatformHint: string | null;
  onRequestUpdateCheck: () => void;
  onRequestVersionSwitch: (release: AvailableRelease) => void;
  onAfterFactoryReset: () => void;
  onInstallVersion: () => void;
  onCancelInstallVersion: () => void;
  onUpdateLater: () => void;
  onUpdateClose: () => void;
  processedOpen: boolean;
  setProcessedOpen: (open: boolean) => void;
  settingsSdActions: () => SdWorkflowActions;
  onSdSelectorClose: () => void;
  onSdSelectorConfirm: (paths: string[], actions: SdWorkflowActions) => void;
  onSdSelectorProceedAll: (actions: SdWorkflowActions) => void;
  onSdSelectorRefresh: () => void;
  cutterOpen: boolean;
  cutterPath: string | null;
  cutterDuration: number;
  onCutterClose: () => void;
  onCutterComplete: (result: VideoCutterResult) => void;
  photoEditorOpen: boolean;
  photoEditorPath: string | null;
  onPhotoEditorClose: () => void;
  onPhotoEditorComplete: (result: PhotoEditorResult) => void;
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  dialogAutoCloseSecs: number | null;
  dialogVariant: DialogVariant;
  dialogHighlight: string;
  dialogActions: DialogActionStatus[];
  dialogQrPreview: QrPreview | null;
  dialogPrimaryAction: DialogPrimaryAction | null;
  dialogConfirm: DialogConfirmOptions | null;
  dialogChoices: DialogChoicesOptions | null;
  closeDialog: () => void;
  openSettings: (opts?: {
    tab?: SettingsTab;
    focus?: SettingsFocusTarget;
  }) => void;
  onSuccessClose: () => void;
  createSuccess: CreateSuccessInfo | null;
  onCreateSuccessClose: () => void;
  introMuxFallback: { reason: string; timeoutSecs: number } | null;
  onIntroMuxChoice: (choice: IntroMuxFallbackChoice) => void;
  bodyConcatFallback: { reason: string } | null;
  onBodyConcatChoice: (choice: BodyConcatFallbackChoice) => void;
  loading: boolean;
  sdWorkflowUiActive: boolean;
  loadingMessage: string;
};

function DialogChunk({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function AppDialogs(props: AppDialogsProps) {
  const {
    config,
    settingsOpen,
    setSettingsOpen,
    setupWizardOpen,
    onSetupComplete,
    updateDialogOpen,
    versionInstall,
    appVersion,
    updateInstalling,
    updateInstallProgress,
    installBlockedReason,
    updaterPlatformHint,
    onRequestUpdateCheck,
    onRequestVersionSwitch,
    onAfterFactoryReset,
    onInstallVersion,
    onCancelInstallVersion,
    onUpdateLater,
    onUpdateClose,
    processedOpen,
    setProcessedOpen,
    settingsSdActions,
    onSdSelectorClose,
    onSdSelectorConfirm,
    onSdSelectorProceedAll,
    onSdSelectorRefresh,
    cutterOpen,
    cutterPath,
    cutterDuration,
    onCutterClose,
    onCutterComplete,
    photoEditorOpen,
    photoEditorPath,
    onPhotoEditorClose,
    onPhotoEditorComplete,
    dialogKind,
    dialogTitle,
    dialogMessage,
    dialogAutoCloseSecs,
    dialogVariant,
    dialogHighlight,
    dialogActions,
    dialogQrPreview,
    dialogPrimaryAction,
    dialogConfirm,
    dialogChoices,
    closeDialog,
    openSettings,
    onSuccessClose,
    createSuccess,
    onCreateSuccessClose,
    introMuxFallback,
    onIntroMuxChoice,
    bodyConcatFallback,
    onBodyConcatChoice,
    loading,
    sdWorkflowUiActive,
    loadingMessage,
  } = props;

  return (
    <>
      {config && (settingsOpen || updateDialogOpen) ? (
        <DialogChunk>
          <LazySettingsDialog
            open={settingsOpen}
            onOpenChange={(open) => {
              if (!open && (updateDialogOpen || updateInstalling)) return;
              setSettingsOpen(open);
            }}
            onRequestUpdateCheck={onRequestUpdateCheck}
            onRequestVersionSwitch={onRequestVersionSwitch}
            installBlockedReason={installBlockedReason}
            platformHint={updaterPlatformHint}
            onAfterFactoryReset={onAfterFactoryReset}
            suppressDismiss={updateDialogOpen || updateInstalling}
          />
        </DialogChunk>
      ) : null}

      {setupWizardOpen ? (
        <DialogChunk>
          <LazySetupWizard open={setupWizardOpen} onComplete={onSetupComplete} />
        </DialogChunk>
      ) : null}

      <UpdateDialog
        open={updateDialogOpen}
        fromVersion={versionInstall?.fromVersion ?? appVersion}
        toVersion={versionInstall?.toVersion ?? null}
        notes={versionInstall?.notes ?? null}
        available={Boolean(versionInstall?.available)}
        message={versionInstall?.message ?? ""}
        installing={updateInstalling}
        installProgress={updateInstallProgress}
        silentAvailable={versionInstall?.silentAvailable ?? true}
        blockedReason={installBlockedReason}
        platformHint={updaterPlatformHint}
        installerUrl={versionInstall?.installerUrl ?? null}
        onInstall={onInstallVersion}
        onCancelInstall={onCancelInstallVersion}
        onLater={onUpdateLater}
        onClose={onUpdateClose}
      />

      <DialogChunk>
        <LazySdFileSelector
          defaultActions={settingsSdActions()}
          onClose={onSdSelectorClose}
          onConfirm={onSdSelectorConfirm}
          onProceedAll={onSdSelectorProceedAll}
          onRefresh={onSdSelectorRefresh}
        />
      </DialogChunk>

      {processedOpen ? (
        <DialogChunk>
          <LazyHistoryDialog open={processedOpen} onOpenChange={setProcessedOpen} />
        </DialogChunk>
      ) : null}

      {cutterOpen ? (
        <DialogChunk>
          <LazyVideoCutter
            open={cutterOpen}
            videoPath={cutterPath}
            durationSecsHint={cutterDuration}
            onClose={onCutterClose}
            onComplete={onCutterComplete}
          />
        </DialogChunk>
      ) : null}

      {photoEditorOpen ? (
        <DialogChunk>
          <LazyPhotoEditor
            open={photoEditorOpen}
            photoPath={photoEditorPath}
            onClose={onPhotoEditorClose}
            onComplete={onPhotoEditorComplete}
          />
        </DialogChunk>
      ) : null}

      <ErrorDialog
        open={dialogKind === "error"}
        title={dialogTitle}
        message={dialogMessage}
        primaryAction={dialogPrimaryAction}
        onPrimaryAction={() => {
          const action = dialogPrimaryAction;
          closeDialog();
          if (action?.openSettings) {
            openSettings(action.openSettings);
          }
        }}
        onClose={closeDialog}
      />
      <SuccessDialog
        open={dialogKind === "success"}
        title={dialogTitle}
        message={dialogMessage}
        autoCloseSecs={dialogAutoCloseSecs}
        variant={dialogVariant}
        highlight={dialogHighlight}
        actions={dialogActions}
        qrPreview={dialogQrPreview}
        confirm={dialogConfirm}
        choices={dialogChoices}
        onClose={onSuccessClose}
      />
      <CreateSuccessDialog
        open={createSuccess !== null}
        info={createSuccess}
        onClose={onCreateSuccessClose}
      />
      <WarningDialog
        open={dialogKind === "warning"}
        title={dialogTitle}
        message={dialogMessage}
        autoCloseSecs={dialogAutoCloseSecs}
        onClose={closeDialog}
      />
      <IntroMuxFallbackDialog
        open={introMuxFallback !== null}
        reason={introMuxFallback?.reason ?? ""}
        timeoutSecs={introMuxFallback?.timeoutSecs ?? 15}
        onChoose={(choice) => {
          void onIntroMuxChoice(choice);
        }}
      />
      <BodyConcatFallbackDialog
        open={bodyConcatFallback !== null}
        reason={bodyConcatFallback?.reason ?? ""}
        onChoose={(choice) => {
          void onBodyConcatChoice(choice);
        }}
      />
      <LoadingOverlay
        open={loading && !sdWorkflowUiActive}
        message={loadingMessage}
      />
      <ToastHost />
    </>
  );
}
