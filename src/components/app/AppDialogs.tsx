import { Suspense } from "react";
import type { AvailableRelease, UpdateInstallProgress } from "../../lib/tauri";
import type { SdWorkflowActions } from "../../lib/sdCard";
import type { IntroMuxFallbackChoice } from "../IntroMuxFallbackDialog";
import type { BodyConcatFallbackChoice } from "../BodyConcatFallbackDialog";
import type { ReencodeConfirmResult, ReencodeConfirmState } from "../ReencodeConfirmDialog";
import type { LowMediaConfirmChoice } from "../LowMediaConfirmDialog";
import type { LowMediaConfirmState } from "@/lib/lowMediaConfirm";
import type { FolderConflictConfirmChoice } from "../FolderConflictConfirmDialog";
import type { FolderConflictConfirmState } from "@/lib/folderConflictConfirm";
import type { OfflineCreateConfirmChoice } from "../OfflineCreateConfirmDialog";
import type { OfflineCreateConfirmState } from "@/lib/offlineCreateConfirm";
import type { BulkPhase2Session, BulkUploadScanResult, BulkUploadSummary, VorgangEntry, VorgangUploadRetryOptions } from "@/lib/vorgangHistory";
import { BulkUploadSummaryDialog } from "../BulkUploadSummaryDialog";
import { defaultEncodeProfile } from "@/lib/encodeProfile";
import type { CreateSuccessInfo } from "../CreateSuccessDialog";
import type { PhotoEditorResult } from "../PhotoEditor";
import type { VideoCutterResult } from "../VideoCutter";
import { ErrorDialog } from "../ErrorDialog";
import { SuccessDialog } from "../SuccessDialog";
import {
  CREATE_SUCCESS_AUTO_CLOSE_SECS,
  CreateSuccessDialog,
} from "../CreateSuccessDialog";
import { WarningDialog } from "../WarningDialog";
import { IntroMuxFallbackDialog } from "../IntroMuxFallbackDialog";
import { BodyConcatFallbackDialog } from "../BodyConcatFallbackDialog";
import { ReencodeConfirmDialog } from "../ReencodeConfirmDialog";
import { LowMediaConfirmDialog } from "../LowMediaConfirmDialog";
import { FolderConflictConfirmDialog } from "../FolderConflictConfirmDialog";
import { OfflineCreateConfirmDialog } from "../OfflineCreateConfirmDialog";
import { LoadingOverlay } from "../LoadingOverlay";
import { ToastHost } from "../ToastHost";
import { UpdateDialog } from "../UpdateDialog";
import type {
  DialogActionStatus,
  DialogChoicesOptions,
  DialogConfirmOptions,
  DialogKind,
  DialogPrimaryAction,
  DialogPromptOptions,
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
    isBeta: boolean;
  } | null;
  appVersion: string;
  updateInstalling: boolean;
  updateInstallProgress: UpdateInstallProgress | null;
  installBlockedReason: string | null;
  updaterPlatformHint: string | null;
  onRequestUpdateCheck: (includeBeta: boolean) => void;
  onRequestVersionSwitch: (release: AvailableRelease) => void;
  onAfterFactoryReset: () => void;
  onInstallVersion: () => void;
  onCancelInstallVersion: () => void;
  onUpdateLater: () => void;
  onUpdateClose: () => void;
  processedOpen: boolean;
  setProcessedOpen: (open: boolean) => void;
  onRetryVorgangUpload: (entry: VorgangEntry, opts?: VorgangUploadRetryOptions) => void;
  onBulkRetryUploads: (scan: BulkUploadScanResult) => void;
  bulkPhase2Session: BulkPhase2Session | null;
  onBulkPhase2Complete: (summary: BulkUploadSummary) => void;
  onBulkPhase2Upload: (
    entry: VorgangEntry,
    opts?: VorgangUploadRetryOptions,
  ) => Promise<"ok" | "failed" | "cancelled">;
  bulkUploadSummary: BulkUploadSummary | null;
  onBulkUploadSummaryClose: () => void;
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
  dialogPrompt: DialogPromptOptions | null;
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
  reencodeConfirm: ReencodeConfirmState | null;
  onReencodeChoice: (result: ReencodeConfirmResult) => void;
  lowMediaConfirm: LowMediaConfirmState | null;
  onLowMediaChoice: (choice: LowMediaConfirmChoice) => void;
  folderConflictConfirm: FolderConflictConfirmState | null;
  onFolderConflictChoice: (choice: FolderConflictConfirmChoice) => void;
  offlineCreateConfirm: OfflineCreateConfirmState | null;
  onOfflineCreateChoice: (choice: OfflineCreateConfirmChoice) => void;
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
    onRetryVorgangUpload,
    onBulkRetryUploads,
    bulkPhase2Session,
    onBulkPhase2Complete,
    onBulkPhase2Upload,
    bulkUploadSummary,
    onBulkUploadSummaryClose,
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
    dialogPrompt,
    closeDialog,
    openSettings,
    onSuccessClose,
    createSuccess,
    onCreateSuccessClose,
    introMuxFallback,
    onIntroMuxChoice,
    bodyConcatFallback,
    onBodyConcatChoice,
    reencodeConfirm,
    onReencodeChoice,
    lowMediaConfirm,
    onLowMediaChoice,
    folderConflictConfirm,
    onFolderConflictChoice,
    offlineCreateConfirm,
    onOfflineCreateChoice,
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
        isBeta={versionInstall?.isBeta ?? false}
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
          <LazyHistoryDialog
            open={processedOpen}
            onOpenChange={setProcessedOpen}
            onRetryUpload={onRetryVorgangUpload}
            onBulkRetryUploads={onBulkRetryUploads}
            bulkPhase2Session={bulkPhase2Session}
            onBulkPhase2Complete={onBulkPhase2Complete}
            onBulkPhase2Upload={onBulkPhase2Upload}
          />
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
        prompt={dialogPrompt}
        onClose={onSuccessClose}
      />
      <CreateSuccessDialog
        open={createSuccess !== null}
        info={createSuccess}
        autoCloseSecs={CREATE_SUCCESS_AUTO_CLOSE_SECS}
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
      <ReencodeConfirmDialog
        open={reencodeConfirm !== null}
        kind={reencodeConfirm?.kind ?? ""}
        reason={reencodeConfirm?.reason ?? ""}
        params={reencodeConfirm?.params ?? {}}
        recommended={
          reencodeConfirm?.recommended ?? defaultEncodeProfile()
        }
        presets={reencodeConfirm?.presets}
        onChoose={(result) => {
          void onReencodeChoice(result);
        }}
      />
      <LowMediaConfirmDialog
        open={lowMediaConfirm !== null}
        reasons={lowMediaConfirm?.reasons ?? []}
        videoCount={lowMediaConfirm?.videoCount ?? 0}
        photoCount={lowMediaConfirm?.photoCount ?? 0}
        uploadToServer={lowMediaConfirm?.uploadToServer ?? false}
        onChoose={onLowMediaChoice}
      />
      <FolderConflictConfirmDialog
        open={folderConflictConfirm !== null}
        folderName={folderConflictConfirm?.folderName ?? ""}
        hasMarker={folderConflictConfirm?.hasMarker ?? false}
        videoFileCount={folderConflictConfirm?.videoFileCount ?? 0}
        photoFileCount={folderConflictConfirm?.photoFileCount ?? 0}
        otherFileCount={folderConflictConfirm?.otherFileCount ?? 0}
        uploadToServer={folderConflictConfirm?.uploadToServer ?? false}
        onChoose={onFolderConflictChoice}
      />
      <OfflineCreateConfirmDialog
        open={offlineCreateConfirm !== null}
        onChoose={onOfflineCreateChoice}
      />
      <BulkUploadSummaryDialog
        open={bulkUploadSummary !== null}
        summary={bulkUploadSummary}
        onClose={onBulkUploadSummaryClose}
      />
      <LoadingOverlay
        open={loading && !sdWorkflowUiActive}
        message={loadingMessage}
      />
      <ToastHost />
    </>
  );
}
