import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { PhotoEditorResult } from "./components/PhotoEditor";
import type { VideoCutterResult } from "./components/VideoCutter";
import type { CreateSuccessInfo } from "./components/CreateSuccessDialog";
import type { IntroMuxFallbackChoice } from "./components/IntroMuxFallbackDialog";
import type { BodyConcatFallbackChoice } from "./components/BodyConcatFallbackDialog";
import type { ReencodeConfirmResult, ReencodeConfirmState } from "./components/ReencodeConfirmDialog";
import type { LowMediaConfirmChoice } from "./components/LowMediaConfirmDialog";
import {
  lowMediaSignature,
  shouldWarnLowMedia,
  type LowMediaConfirmState,
} from "./lib/lowMediaConfirm";
import type { FolderConflictConfirmChoice } from "./components/FolderConflictConfirmDialog";
import {
  folderConflictSignature,
  shouldWarnFolderConflict,
  toFolderConflictConfirmState,
  type FolderConflictConfirmState,
} from "./lib/folderConflictConfirm";
import type { OfflineCreateConfirmChoice } from "./components/OfflineCreateConfirmDialog";
import type { OfflineCreateConfirmState } from "./lib/offlineCreateConfirm";
import { defaultEncodeProfile } from "./lib/encodeProfile";
import { SplashScreen } from "./components/SplashScreen";
import { AppShell } from "./components/app/AppShell";
import { AppDialogs } from "./components/app/AppDialogs";
import type { TaskProgressState } from "./components/app/types";
import { useVideoStore } from "./store/videoStore";
import { usePhotoStore } from "./store/photoStore";
import { useConfigStore } from "./store/configStore";
import { useLocaleStore } from "./store/localeStore";
import { normalizeUiLanguage } from "./i18n/types";
import { tr } from "@/i18n";
import { useKundeStore } from "./store/kundeStore";
import { useUiStore, type DialogActionStatus } from "./store/uiStore";
import { useSdStore, isSdPipelineBusy } from "./store/sdStore";
import { useServerStore } from "./store/serverStore";
import { useAppendStore } from "./store/appendStore";
import { usePreviewCacheStore, previewEncodingSignature, getPreviewReusePlan } from "./store/previewCacheStore";
import { buildCreateJobPlan, type CreateJobPlan } from "./lib/createJobPlan";
import { useSdCardMonitor } from "./hooks/useSdCardMonitor";
import { useVideoCutApply } from "./hooks/useVideoCutApply";
import { usePhotoEditApply } from "./hooks/usePhotoEditApply";
import { useLogListener } from "./hooks/useLogListener";
import { useServerHealthPoll } from "./hooks/useServerHealthPoll";
import { useAmsHandoffPoll } from "./hooks/useAmsHandoffPoll";
import { useLogStore } from "./store/logStore";
import {
  checkForUpdates,
  discardVideoCutUndoForPath,
  clearWorkingSession,
  createJob,
  cleanupCache,
  focusMainWindowAfterUpdate,
  getAppInfo,
  getUpdaterInstallHint,
  cancelUpdateInstall,
  cancelEncode,
  cancelUploadSlot,
  installSpecificVersion,
  installUpdate,
  resolveBodyConcatFallback,
  resolveIntroMuxFallback,
  resolveReencodeConfirm,
  resetUploadSlotCancel,
  resetWorkflowCancel,
  runStartupChecks,
  uploadToServer,
  validateCreateJob,
  probeCreateOutputFolder,
  type AvailableRelease,
  type BodyConcatFallbackPayload,
  type CreateJobResult,
  type HwAccelInfo,
  type IntroMuxFallbackPayload,
  type ReencodeConfirmPayload,
  type UpdateInstallProgress,
  type UploadProgressEvent,
} from "./lib/tauri";
import { compareVersionParts, isVersionPrerelease } from "./lib/versionCompare";
import {
  backupSdCard,
  ejectSdCard,
  emptyCatalogLabel,
  enrichSdFiles,
  importSdFiles,
  isEmptyCatalogMessage,
  isMtpDrive,
  listSdFiles,
  scanSdDrives,
  type SdWorkflowActions,
} from "./lib/sdCard";
import {
  resolveSdEjectDetail,
  showSdEjectToast,
} from "./lib/sdEjectToast";
import { showSdQueueDroppedToast } from "./lib/sdQueueToast";
import { showSessionResetToast } from "./lib/sessionResetToast";
import {
  pathsAddedSince,
  runAutoQrAfterImport,
  shouldAutoQrAfterImport,
  type AutoQrScanOutcome,
} from "./lib/autoQrScan";
import { fileBaseName } from "./lib/qrSuccess";
import {
  requestKundenIdFocus,
  requestKundenIdFocusAfterImport,
} from "./lib/kundenIdFocus";
import {
  useQrScanStore,
  withQrScanProgress,
} from "./store/qrScanStore";
import { useQrScanProgressListener } from "./hooks/useQrScanProgress";
import {
  applyMonotonicPercent,
  formatOverallProgressLabel,
  resolveProgressLabel,
  shouldClearTaskProgress,
} from "./lib/progressLabels";
import { translateValidationHint } from "./lib/createReadyHints";
import {
  presentLinuxMediaWarning,
  presentStartupCheckMessage,
  presentStartupFfmpegError,
} from "./lib/startupCheckMessages";
import { presentAmsUserMessage } from "./lib/amsBridgeStatus";
import { runAmsAutoConnect } from "./lib/amsAutoConnect";
import { isCancellationError } from "./lib/utils";
import { isImportCancellation, rollbackImportBatch } from "./lib/importRollback";
import {
  preflightVorgangUpload,
  refreshPendingUploadCount,
  reconcileStaleUploads,
  setVorgangUploadState,
  getHandoffStatus,
  bulkSummaryItemFromScanEntry,
  createEmptyBulkUploadSummary,
  type BulkPhase2Session,
  type BulkUploadScanResult,
  type BulkUploadSummary,
  type VorgangEntry,
  type VorgangUploadRetryOptions,
} from "./lib/vorgangHistory";
import {
  classifyBulkPreflight,
  primaryPreflightReasonCode,
} from "./lib/uploadPreflight";
import { showPendingUploadsToast } from "./lib/pendingUploadToast";
import {
  showBackgroundUploadDoneToast,
  showBackgroundUploadFailToast,
} from "./lib/backgroundUploadToast";
import {
  bindUploadSlotRunner,
  cancelQueuedUploads,
  enqueueUpload,
  type UploadSlotResult,
} from "./lib/uploadSlot";
import type { UploadQueueJob } from "./lib/uploadQueue";
import { useHistoryStore } from "./store/historyStore";
import { useUploadQueueStore } from "./store/uploadQueueStore";
import { applyHandoffToEntry } from "./lib/amsHandoffPatch";
import type { EncodeProgress } from "./components/app/types";
import { QuitUploadConfirmDialog } from "./components/QuitUploadConfirmDialog";
import {
  useQuitUploadConfirmState,
  useUploadQuitGuard,
} from "./hooks/useUploadQuitGuard";
import "./App.css";

function App() {
  const { t } = useTranslation();
  const videoList = useVideoStore((s) => s.videoList);
  const addVideos = useVideoStore((s) => s.addVideos);
  const clearVideos = useVideoStore((s) => s.clearVideos);
  const addPhotos = usePhotoStore((s) => s.addPhotos);
  const clearPhotos = usePhotoStore((s) => s.clearPhotos);
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const persistConfig = useConfigStore((s) => s.persist);
  const kunde = useKundeStore((s) => s.kunde);
  const qrPreview = useKundeStore((s) => s.qrPreview);
  const applyDefaultsFromConfig = useKundeStore((s) => s.applyDefaultsFromConfig);
  const resetSession = useKundeStore((s) => s.resetSession);
  const clearPreviewCache = usePreviewCacheStore((s) => s.clear);
  const cachedPreviewPath = usePreviewCacheStore((s) => s.previewPath);
  const cachedPreviewFingerprint = usePreviewCacheStore((s) => s.fingerprint);

  const dialogKind = useUiStore((s) => s.dialogKind);
  const dialogTitle = useUiStore((s) => s.dialogTitle);
  const dialogMessage = useUiStore((s) => s.dialogMessage);
  const dialogAutoCloseSecs = useUiStore((s) => s.dialogAutoCloseSecs);
  const dialogVariant = useUiStore((s) => s.dialogVariant);
  const dialogHighlight = useUiStore((s) => s.dialogHighlight);
  const dialogActions = useUiStore((s) => s.dialogActions);
  const dialogQrPreview = useUiStore((s) => s.dialogQrPreview);
  const dialogPrimaryAction = useUiStore((s) => s.dialogPrimaryAction);
  const dialogConfirm = useUiStore((s) => s.dialogConfirm);
  const dialogChoices = useUiStore((s) => s.dialogChoices);
  const dialogPrompt = useUiStore((s) => s.dialogPrompt);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);
  const loading = useUiStore((s) => s.loading);
  const loadingMessage = useUiStore((s) => s.loadingMessage);
  const setLoading = useUiStore((s) => s.setLoading);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const clearCreateReadyPulse = useUiStore((s) => s.clearCreateReadyPulse);

  const setServerPhase = useServerStore((s) => s.setPhase);
  const setUploadProgress = useServerStore((s) => s.setUploadProgress);
  const serverConnected = useServerStore((s) => s.connected);

  const closeSelector = useSdStore((s) => s.closeSelector);
  const openSelector = useSdStore((s) => s.openSelector);
  const replaceSelectorCatalog = useSdStore((s) => s.replaceSelectorCatalog);
  const patchSelectorFiles = useSdStore((s) => s.patchSelectorFiles);
  const setIntakeBusy = useSdStore((s) => s.setIntakeBusy);
  const shiftSdJob = useSdStore((s) => s.shiftSdJob);
  const pruneQueueToMounted = useSdStore((s) => s.pruneQueueToMounted);
  const clearSdQueue = useSdStore((s) => s.clearSdQueue);
  const setDrives = useSdStore((s) => s.setDrives);
  const processedOpen = useSdStore((s) => s.processedOpen);
  const setProcessedOpen = useSdStore((s) => s.setProcessedOpen);
  const setPhase = useSdStore((s) => s.setPhase);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const qrScanBusy = useQrScanStore((s) => s.busy);

  const [hwInfo, setHwInfo] = useState<HwAccelInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState("");
  const [taskProgress, setTaskProgress] = useState<TaskProgressState[]>([]);
  const [createJobPlan, setCreateJobPlan] = useState<CreateJobPlan | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  /** Shared media list + preview tab (video | foto). */
  const [mediaTab, setMediaTab] = useState<"video" | "foto">("video");
  const photoList = usePhotoStore((s) => s.photoList);
  const defaultsApplied = useRef(false);
  const sdEnrichGenRef = useRef(0);
  const [cutterOpen, setCutterOpen] = useState(false);
  const [cutterPath, setCutterPath] = useState<string | null>(null);
  const [cutterDuration, setCutterDuration] = useState(0);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [photoEditorPath, setPhotoEditorPath] = useState<string | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [versionInstall, setVersionInstall] = useState<{
    fromVersion: string;
    toVersion: string | null;
    notes: string | null;
    available: boolean;
    message: string;
    /** null + silent → installUpdate() (latest feed); string → specific release */
    updaterJsonUrl: string | null;
    silentAvailable: boolean;
    installerUrl: string | null;
    isBeta: boolean;
  } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateInstallProgress, setUpdateInstallProgress] =
    useState<UpdateInstallProgress | null>(null);
  const [updaterPlatformHint, setUpdaterPlatformHint] = useState<string | null>(
    null,
  );
  const [splashOpen, setSplashOpen] = useState(true);
  const [splashStatus, setSplashStatus] = useState("");
  const [splashError, setSplashError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [ready, setReady] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessInfo | null>(null);
  const quitUploadConfirm = useQuitUploadConfirmState();
  const { onConfirmQuit, onConfirmStay } = useUploadQuitGuard({
    openConfirm: quitUploadConfirm.openConfirm,
    confirmOpen: quitUploadConfirm.open,
  });
  const [introMuxFallback, setIntroMuxFallback] = useState<{
    reason: string;
    timeoutSecs: number;
  } | null>(null);
  const [bodyConcatFallback, setBodyConcatFallback] = useState<{
    reason: string;
  } | null>(null);
  const [reencodeConfirm, setReencodeConfirm] =
    useState<ReencodeConfirmState | null>(null);
  const [lowMediaConfirm, setLowMediaConfirm] =
    useState<LowMediaConfirmState | null>(null);
  const [folderConflictConfirm, setFolderConflictConfirm] =
    useState<FolderConflictConfirmState | null>(null);
  const [offlineCreateConfirm, setOfflineCreateConfirm] =
    useState<OfflineCreateConfirmState | null>(null);
  const [bulkUploadSummary, setBulkUploadSummary] =
    useState<BulkUploadSummary | null>(null);
  const [bulkPhase2Session, setBulkPhase2Session] =
    useState<BulkPhase2Session | null>(null);
  /** Ack signature: warn once per Vorgang until media/products change (Phase 29). */
  const lowMediaAckRef = useRef<string | null>(null);
  /** Ack signature after user chose Replace for this planned folder (Phase 30). */
  const folderConflictAckRef = useRef<string | null>(null);
  /** Soft-ack: create locally while upload is on but server offline (Phase 31.1). */
  const offlineCreateAckRef = useRef(false);
  const replaceExistingDirRef = useRef(false);
  /** Track SMB connected edge for optional reconnect toast (Phase 31.3). */
  const serverWasConnectedRef = useRef(false);
  const pendingUploadToastArmedRef = useRef(false);
  /** SD workflow (Auto + Confirm after submit): floating progress + UI lock. */
  const [sdWorkflowUiActive, setSdWorkflowUiActive] = useState(false);
  const sdDrainLockRef = useRef(false);
  const sdDrainTimerRef = useRef<number | null>(null);
  const amsAutoConnectKeyRef = useRef("");

  const videoCuts = useVideoCutApply();
  const photoEdits = usePhotoEditApply();
  useQrScanProgressListener();
  useLogListener();
  const consoleOpen = useLogStore((s) => s.open);
  const toggleConsole = useLogStore((s) => s.toggleOpen);
  const setConsoleOpen = useLogStore((s) => s.setOpen);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);

  const serverPhase = useServerStore((s) => s.phase);

  const appendActive = useAppendStore((s) => s.active);
  const appendWasActiveRef = useRef(false);
  const uploadProgressActiveRef = useRef(false);
  const sessionCancelRequestedRef = useRef(false);
  const uploadCancelRequestedRef = useRef(false);
  /** Latest SMB slot executor (bound once; body refreshed each render). */
  const uploadSlotRunnerRef = useRef<
    (job: UploadQueueJob) => Promise<UploadSlotResult>
  >(async () => "failed");
  const uploadSlotHasWork = useUploadQueueStore(
    (s) => s.active !== null || s.queue.length > 0,
  );

  const installBlockedReason = (() => {
    if (updateInstalling) return t("app.update.alreadyInstalling");
    if (busy) return t("app.update.blockedBusy");
    if (appendActive) return t("app.update.blockedAppend");
    if (sdWorkflowUiActive) return t("app.update.blockedSd");
    if (qrScanBusy) return t("app.update.blockedQr");
    if (serverPhase === "uploading" || uploadSlotHasWork)
      return t("app.update.blockedUpload");
    return null;
  })();

  async function runUpdateCheck(forceDialog = false, includeBeta?: boolean) {
    const betaEnabled =
      includeBeta ?? config?.beta_updates_enabled ?? false;
    try {
      const result = await checkForUpdates(betaEnabled);
      setVersionInstall({
        fromVersion: result.current_version,
        toVersion: result.latest_version,
        notes: result.body,
        available: result.available,
        message: result.message,
        updaterJsonUrl: result.updater_json_url,
        silentAvailable: Boolean(result.updater_json_url ?? !result.prerelease),
        installerUrl: result.installer_url,
        isBeta:
          result.prerelease ||
          (result.latest_version
            ? isVersionPrerelease(result.latest_version)
            : false),
      });
      if (forceDialog || result.available) {
        setUpdateDialogOpen(true);
      }
    } catch (e) {
      if (forceDialog) showError(String(e), t("app.update.title"));
    }
  }

  function openVersionSwitchDialog(release: AvailableRelease) {
    if (installBlockedReason) {
      showError(installBlockedReason, t("app.update.title"));
      return;
    }
    const from = appVersion || "—";
    const cmp = compareVersionParts(release.tag_name, from);
    const isDowngrade = cmp < 0;
    setVersionInstall({
      fromVersion: from,
      toVersion: release.tag_name,
      notes: release.body,
      available: true,
      message: !release.updater_json_url
        ? t("settings.system.update.noAutoInstall")
        : isDowngrade
          ? t("app.update.switchTo", { version: release.tag_name })
          : t("app.update.availableOn", { version: release.tag_name }),
      updaterJsonUrl: release.updater_json_url,
      silentAvailable: Boolean(release.updater_json_url),
      installerUrl: release.installer_url,
      isBeta: release.prerelease || isVersionPrerelease(release.tag_name),
    });
    setUpdateDialogOpen(true);
  }

  async function runInstallVersion() {
    if (!versionInstall || installBlockedReason) return;
    if (!versionInstall.silentAvailable) return;
    setUpdateInstalling(true);
    setUpdateInstallProgress(null);
    try {
      const msg = versionInstall.updaterJsonUrl
        ? await installSpecificVersion(versionInstall.updaterJsonUrl)
        : await installUpdate();
      showSuccess(msg, t("app.update.title"));
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        showWarning(t("app.update.restartManual"));
      }
    } catch (e) {
      const msg = String(e);
      if (/abgebrochen/i.test(msg)) {
        // Stay on dialog so user can retry or dismiss with Später.
      } else {
        showError(msg, t("app.update.title"));
      }
    } finally {
      setUpdateInstalling(false);
      setUpdateInstallProgress(null);
    }
  }

  async function cancelInstallVersion() {
    if (!updateInstalling) return;
    if (updateInstallProgress?.phase === "install") return;
    try {
      await cancelUpdateInstall();
    } catch {
      // ignore — install command will surface cancel/error
    }
  }

  function scheduleSdQueueDrain(delayMs = 0) {
    if (sdDrainTimerRef.current != null) {
      window.clearTimeout(sdDrainTimerRef.current);
    }
    sdDrainTimerRef.current = window.setTimeout(() => {
      sdDrainTimerRef.current = null;
      void drainSdQueue();
    }, delayMs);
  }

  async function drainSdQueue() {
    if (sdDrainLockRef.current) return;
    if (isSdPipelineBusy()) return;

    // Never force-close dialogs: QR confirm awaits a Promise that would hang
    // if we clear dialogKind without resolving onSecondary/onPrimary.
    const ui = useUiStore.getState();
    if (ui.dialogKind != null) {
      scheduleSdQueueDrain(ui.dialogConfirm ? 600 : 400);
      return;
    }

    sdDrainLockRef.current = true;
    let job = null as ReturnType<typeof shiftSdJob>;
    try {
      try {
        const list = await scanSdDrives();
        setDrives(list);
        const dropped = pruneQueueToMounted(list.map((d) => d.drive));
        for (const d of dropped) {
          showSdQueueDroppedToast(d.drive);
        }
      } catch {
        /* ignore — still try queued drives */
      }

      if (isSdPipelineBusy() || useUiStore.getState().dialogKind != null) {
        return;
      }
      job = shiftSdJob();
    } finally {
      sdDrainLockRef.current = false;
    }

    if (!job) return;

    const stillThere = useSdStore
      .getState()
      .drives.some((d) => d.drive === job!.drive);
    if (!stillThere) {
      showSdQueueDroppedToast(job.drive);
      scheduleSdQueueDrain();
      return;
    }

    await new Promise((r) => window.setTimeout(r, 400));

    if (isSdPipelineBusy() || useUiStore.getState().dialogKind != null) {
      useSdStore.getState().prependSdJob(job);
      scheduleSdQueueDrain(500);
      return;
    }

    if (job.kind === "auto") {
      const actions = job.actions ?? settingsSdActions();
      await runAutoSdWorkflow(job.drive, actions);
      return;
    }

    await openSdSelector(
      job.drive,
      job.kind === "size_limit" ? "size_limit" : "backup",
    );
  }

  async function openSdSelector(
    drive: string,
    mode: "backup" | "import" | "size_limit" = "backup",
  ) {
    setActiveDrive(drive);
    setPhase(mode === "backup" || mode === "size_limit" ? "confirming" : "importing");
    setIntakeBusy(true);
    const streaming = isMtpDrive(drive);
    const alreadyOpen =
      useSdStore.getState().selectorOpen &&
      useSdStore.getState().selectorDrive === drive;
    if (streaming || alreadyOpen) {
      // Open immediately — GoPro PTP catalog can take ~1 min for hundreds of files.
      openSelector({
        drive,
        files: [],
        totalMb: 0,
        mode,
        listing: true,
      });
    } else {
      setLoading(true, t("app.sd.readingFiles"));
    }
    try {
      const listed = await listSdFiles(drive);
      const st = useSdStore.getState();
      if (st.selectorOpen && st.selectorDrive === drive) {
        replaceSelectorCatalog(
          drive,
          listed.files,
          listed.total_size_mb,
          false,
          listed.empty_reason ?? (listed.files.length === 0 ? "no_media" : null),
        );
      } else if (!streaming) {
        openSelector({
          drive,
          files: listed.files,
          totalMb: listed.total_size_mb,
          mode,
        });
        if (listed.files.length === 0) {
          replaceSelectorCatalog(
            drive,
            listed.files,
            listed.total_size_mb,
            false,
            listed.empty_reason ?? "no_media",
          );
        }
      } else {
        return;
      }
      // EXIF / "bekannt" in background — dialog already open with mtime dates.
      const gen = ++sdEnrichGenRef.current;
      const paths = listed.files.map((f) => f.path);
      void enrichSdFiles(drive, paths)
        .then((updates) => {
          if (gen !== sdEnrichGenRef.current) return;
          const cur = useSdStore.getState();
          if (!cur.selectorOpen || cur.selectorDrive !== drive) return;
          patchSelectorFiles(updates);
        })
        .catch(() => undefined);
    } catch (e) {
      const msg = String(e);
      if (isEmptyCatalogMessage(msg)) {
        const st = useSdStore.getState();
        if (st.selectorOpen && st.selectorDrive === drive) {
          replaceSelectorCatalog(drive, [], 0, false, "no_media");
          return;
        }
        showWarning(msg, t("app.sd.title"));
      } else {
        showError(msg);
        if (streaming) closeSelector();
      }
      scheduleSdQueueDrain();
    } finally {
      setIntakeBusy(false);
      setLoading(false);
      setPhase("monitoring");
    }
  }

  function openSdDriveFromHeader(drive: string) {
    return openSdSelector(drive, "backup");
  }

  function settingsSdActions(): SdWorkflowActions {
    const backup = Boolean(config?.sd_auto_backup);
    return {
      backup,
      import: Boolean(config?.sd_auto_import),
      // Clear only together with backup
      clear: backup && Boolean(config?.sd_clear_after_backup),
      eject: Boolean(config?.sd_eject_after_workflow),
    };
  }

  async function importPathsIntoApp(
    paths: string[],
    opts?: { scanQr?: boolean },
  ): Promise<{
    importAction: DialogActionStatus;
    qrAction: DialogActionStatus | null;
    qrHit: AutoQrScanOutcome | null;
  }> {
    const emptyImport = (): {
      importAction: DialogActionStatus;
      qrAction: DialogActionStatus | null;
      qrHit: AutoQrScanOutcome | null;
    } => ({
      importAction: {
        kind: "import",
        label: t("app.import.label"),
        tone: "skipped",
        summary: t("app.sd.noFiles"),
      },
      qrAction: null,
      qrHit: null,
    });

    if (paths.length === 0) return emptyImport();

    const beforeVideoPaths = useVideoStore.getState().videoList.map((v) => v.path);
    const beforePhotoPaths = usePhotoStore.getState().photoList.map((p) => p.path);

    const result = await importSdFiles(paths);
    try {
      if (result.imported_videos.length > 0) {
        await addVideos(result.imported_videos);
      }
      if (result.imported_photos.length > 0) {
        await addPhotos(result.imported_photos);
      }
    } catch (e) {
      if (isImportCancellation(e)) {
        await rollbackImportBatch({ beforeVideoPaths, beforePhotoPaths });
      }
      throw e;
    }

    const newVideoPaths = pathsAddedSince(
      beforeVideoPaths,
      useVideoStore.getState().videoList.map((v) => v.path),
    );
    const newPhotoPaths = pathsAddedSince(
      beforePhotoPaths,
      usePhotoStore.getState().photoList.map((p) => p.path),
    );

    if (result.imported_photos.length > 0 && result.imported_videos.length === 0) {
      setMediaTab("foto");
    } else if (result.imported_videos.length > 0) {
      setMediaTab("video");
    }

    const importSummary =
      t("app.import.summary", {
        videos: result.imported_videos.length,
        photos: result.imported_photos.length,
      }) +
      (result.skipped ? t("app.import.skipped", { count: result.skipped }) : "");

    const importAction: DialogActionStatus = {
      kind: "import",
      label: tr("app.import.label"),
      tone: "success",
      summary: importSummary,
    };

    // Confirm: `scanQr` true/false overrides settings.
    // Auto / unset: follow qr_check flags, but skip when session already has QR kunde.
    const scanOverride = opts?.scanQr;
    const forceScan = scanOverride === true;
    const willAutoScan =
      scanOverride === false
        ? false
        : shouldAutoQrAfterImport({
            force: forceScan,
            videoPaths: newVideoPaths,
            photoPaths: newPhotoPaths,
            qrCheckEnabled: config?.qr_check_enabled,
            photoQrCheckEnabled: config?.photo_qr_check_enabled,
          });

    const hasNewMedia = newVideoPaths.length > 0 || newPhotoPaths.length > 0;
    if (!willAutoScan) {
      if (hasNewMedia) {
        requestKundenIdFocusAfterImport({ scanned: false });
      }
      return { importAction, qrAction: null, qrHit: null };
    }

    useSdStore.getState().setWorkflowProgress(null);
    // Overlay stays suppressed while sdWorkflowUiActive; message feeds SD progress.
    setLoading(true, t("app.sd.searchingQr"));
    try {
      const qr = await withQrScanProgress(
        [...newVideoPaths, ...newPhotoPaths],
        () =>
          runAutoQrAfterImport({
            videoPaths: newVideoPaths,
            photoPaths: newPhotoPaths,
            forceScan,
            onBeforeRemoveVideo: (p) => {
              useVideoStore.getState().clearCutMarksFor([p]);
              void discardVideoCutUndoForPath(p);
            },
          }),
      );

      if (!qr.attempted) {
        return { importAction, qrAction: null, qrHit: null };
      }

      if (qr.cancelled) {
        return {
          importAction,
          qrAction: {
            kind: "qr",
            label: t("app.qr.label"),
            tone: "warning",
            summary: qr.message || t("app.qr.cancelled"),
          },
          qrHit: null,
        };
      }

      if (qr.found) {
        const fromOptions = qr.successOptions?.actions?.find((a) => a.kind === "qr");
        const src = fileBaseName(qr.source_path);
        return {
          importAction,
          qrAction: fromOptions ?? {
            kind: "qr",
            label: t("app.qr.label"),
            tone: "success",
            summary: t("app.qr.applied"),
            detail: src ? t("app.qr.source", { name: src }) : undefined,
          },
          qrHit: qr,
        };
      }

      requestKundenIdFocusAfterImport({
        scanned: true,
        attempted: true,
        found: false,
        cancelled: false,
      });
      return {
        importAction,
        qrAction: {
          kind: "qr",
          label: t("app.qr.label"),
          tone: "warning",
          summary: qr.message || t("app.qr.notFound"),
        },
        qrHit: null,
      };
    } catch (qrErr) {
      requestKundenIdFocus();
      return {
        importAction,
        qrAction: {
          kind: "qr",
          label: t("app.qr.label"),
          tone: "error",
          summary: t("app.qr.scanFailed"),
          detail: String(qrErr),
        },
        qrHit: null,
      };
    } finally {
      // autoQrScan no longer clears loading (avoids overlay on manual import).
      setLoading(false);
    }
  }

  /** Unified SD pipeline: backup → eject → import/QR; clear only after successful backup.
   *  Import-only (no backup): eject after import. SD is free as soon as copies exist.
   *  @returns false if validation failed before any work started. */
  async function runSdWorkflow(
    drive: string,
    selectedPaths: string[] | null,
    actions: SdWorkflowActions,
    hooks?: { onStart?: () => void },
  ): Promise<boolean> {
    // Safety (Auto + Confirm): never clear without a backup in the same run.
    const doBackup = actions.backup || actions.clear;
    const doImport = actions.import;
    const doClear = actions.clear && doBackup;
    const doEject = actions.eject;

    if (!doBackup && !doImport && !doEject) {
      showWarning(
        actions.clear
          ? t("app.sd.clearOnlyAfterBackup")
          : t("app.sd.noActionSelected"),
      );
      return false;
    }
    if (!doBackup && actions.clear) {
      showWarning(t("app.sd.clearOnlyAfterBackup"));
      return false;
    }

    if (doBackup && !config?.sd_backup_folder?.trim()) {
      showError(t("app.sd.pickBackupFolder"));
      return false;
    }

    hooks?.onStart?.();
    useSdStore.getState().setWorkflowActive(true);
    useSdStore.getState().beginWorkflowMount(drive);
    setLoading(true, t("app.sd.processing"));
    const statusActions: DialogActionStatus[] = [];
    let qrHit: AutoQrScanOutcome | null = null;
    let ejected = false;

    async function tryEjectSd(opts?: { midWorkflowToast?: boolean }): Promise<void> {
      if (!doEject || ejected) return;
      ejected = true;
      const ejectDetail = resolveSdEjectDetail(drive);
      setLoading(true, t("app.sd.ejecting"));
      try {
        await ejectSdCard(drive);
        useSdStore.getState().markWorkflowMountReleased();
        statusActions.push({
          kind: "eject",
          label: t("app.sd.ejectLabel"),
          tone: "success",
          summary: t("app.sd.ejectSuccess"),
          detail: ejectDetail,
        });
        if (opts?.midWorkflowToast) {
          showSdEjectToast({ drive, detail: ejectDetail, ok: true });
        }
      } catch (e) {
        statusActions.push({
          kind: "eject",
          label: t("app.sd.ejectLabel"),
          tone: "error",
          summary: t("app.sd.ejectFailed"),
          detail: t("app.sd.ejectFailedDetail", { error: String(e) }),
        });
        if (opts?.midWorkflowToast) {
          showSdEjectToast({
            drive,
            detail: ejectDetail,
            ok: false,
            error: String(e),
          });
        }
      }
    }

    try {
      let importPaths: string[] = selectedPaths ? [...selectedPaths] : [];

      if (doBackup) {
        setPhase("backing_up");
        setLoading(true, t("app.sd.backingUp"));
        const res = await backupSdCard(drive, selectedPaths, doClear);
        if (!res.success) {
          if (isCancellationError(res.error_message)) {
            showWarning(t("app.sd.backupCancelled"), t("app.sd.backupLabel"));
            return true;
          }
          const failMsg =
            (res.error_message || t("app.sd.backupFailed")) +
            (actions.clear
              ? `\n\n${t("app.sd.notClearedNoBackup")}`
              : "");
          if (isEmptyCatalogMessage(res.error_message || "")) {
            showWarning(failMsg, t("app.sd.title"));
          } else {
            showError(failMsg);
          }
          return true;
        }
        const backupDetails = [
          res.backup_path ?? "",
          res.secondary_backup_path
            ? t("app.sd.secondPath", { path: res.secondary_backup_path })
            : res.secondary_async_started
              ? t("app.sd.secondPathBackground")
              : "",
          res.skipped_count ? t("app.sd.skippedCount", { count: res.skipped_count }) : "",
          res.secondary_warning?.trim() ?? "",
        ]
          .map((s) => s.trim())
          .filter(Boolean);
        const backupWarn = Boolean(res.secondary_warning?.trim());
        statusActions.push({
          kind: "backup",
          label: t("app.sd.backupLabel"),
          tone: backupWarn ? "warning" : "success",
          summary: t("app.sd.copiedFiles", { count: res.copied_count }),
          detail: backupDetails.length ? backupDetails.join("\n") : undefined,
        });
        if (doClear) {
          const clearWarn = Boolean(res.clear_warning?.trim());
          const deleted = res.clear_deleted_count ?? 0;
          if (clearWarn || deleted <= 0) {
            statusActions.push({
              kind: "clear",
              label: t("app.sd.clearLabel"),
              tone: "warning",
              summary: clearWarn
                ? t("app.sd.clearFailed")
                : t("app.sd.notCleared"),
              detail: res.clear_warning?.trim() || undefined,
            });
          } else {
            statusActions.push({
              kind: "clear",
              label: t("app.sd.clearLabel"),
              tone: "success",
              summary: t("app.sd.clearedFiles", { count: deleted }),
            });
          }
        }
        // Import from backup copies so clear-after-backup is safe
        if (doImport) {
          importPaths =
            res.copied_dest_paths.length > 0
              ? res.copied_dest_paths
              : selectedPaths ?? [];
        }

        // Free the card as soon as import no longer needs SD paths.
        const importNeedsSd =
          doImport &&
          importPaths.length > 0 &&
          res.copied_dest_paths.length === 0;
        if (!importNeedsSd) {
          await tryEjectSd({
            // Toast only while more work (import/QR) continues — final dialog covers end-of-run.
            midWorkflowToast: Boolean(doImport && importPaths.length > 0),
          });
        }
      } else if (doImport && !selectedPaths) {
        const listed = await listSdFiles(drive);
        importPaths = listed.files.map((f) => f.path);
      }

      if (doImport) {
        if (importPaths.length === 0) {
          statusActions.push({
            kind: "import",
            label: t("app.import.label"),
            tone: "skipped",
            summary: t("app.sd.noFiles"),
          });
        } else {
          setPhase("importing");
          useSdStore.getState().setBackupProgress(null);
          useSdStore.getState().setWorkflowProgress(null);
          setLoading(true, t("app.sd.importing"));
          const imported = await importPathsIntoApp(importPaths, {
            scanQr: actions.scanQr,
          });
          statusActions.push(imported.importAction);
          if (imported.qrAction) statusActions.push(imported.qrAction);
          if (imported.qrHit) qrHit = imported.qrHit;
        }
      }

      // Import-only, or backup with no dest copies still pointing at SD paths.
      await tryEjectSd();

      if (statusActions.length) {
        // QR first for spotlight; then chronological: backup → clear → eject → import.
        const order: Record<DialogActionStatus["kind"], number> = {
          qr: 0,
          backup: 1,
          clear: 2,
          eject: 3,
          import: 4,
          server: 5,
          ams: 6,
        };
        statusActions.sort((a, b) => order[a.kind] - order[b.kind]);

        const hasError = statusActions.some((a) => a.tone === "error");
        const title = hasError
          ? t("app.sd.partialSuccess")
          : qrHit?.applied
            ? (qrHit.successTitle ?? t("app.qr.recognized"))
            : qrHit?.keptExisting
              ? t("common.status.success")
              : qrHit
                ? (qrHit.successTitle ?? t("app.qr.recognized"))
                : t("common.status.success");

        const queuedNext = useSdStore.getState().jobQueue.length > 0;
        showSuccess("", title, {
          ...(qrHit?.applied || qrHit?.keptExisting
            ? (qrHit.successOptions ?? {
                variant: "qr" as const,
                highlight: qrHit.kundeName || t("app.sd.customerRecognized"),
              })
            : {}),
          // Free the pipeline sooner when another SD is waiting.
          autoCloseSecs: queuedNext ? 2 : 5,
          actions: statusActions,
        });
      }
      return true;
    } catch (e) {
      if (isCancellationError(e)) {
        showWarning(t("app.sd.workflowCancelled"), t("app.sd.title"));
        return true;
      }
      showError(String(e));
      return true;
    } finally {
      setLoading(false);
      useSdStore.getState().setWorkflowActive(false);
      useSdStore.getState().clearWorkflowMount();
      setPhase("monitoring");
      useSdStore.getState().setBackupProgress(null);
      useSdStore.getState().setWorkflowProgress(null);
      scheduleSdQueueDrain();
    }
  }

  /**
   * Auto mode: LoadingOverlay while listing the card (like Confirm),
   * then floating progress panel for the actual workflow.
   */
  async function runAutoSdWorkflow(drive: string, actions: SdWorkflowActions) {
    setActiveDrive(drive);
    setSdWorkflowUiActive(false);
    setIntakeBusy(true);
    setLoading(true, t("app.sd.readingFiles"));
    try {
      const listed = await listSdFiles(drive);
      if (listed.files.length === 0) {
        setIntakeBusy(false);
        setLoading(false);
        if (actions.eject) {
          await runSdWorkflow(
            drive,
            [],
            {
              backup: false,
              import: false,
              clear: false,
              eject: true,
              scanQr: false,
            },
            {
              onStart: () => setSdWorkflowUiActive(true),
            },
          );
        } else {
          showWarning(emptyCatalogLabel(drive, listed.empty_reason), "SD");
          scheduleSdQueueDrain();
        }
        return;
      }
      setIntakeBusy(false);
      await runSdWorkflow(drive, null, actions, {
        onStart: () => setSdWorkflowUiActive(true),
      });
    } catch (e) {
      const msg = String(e);
      if (isEmptyCatalogMessage(msg)) {
        showWarning(msg, t("app.sd.title"));
      } else {
        showError(msg);
      }
      scheduleSdQueueDrain();
    } finally {
      setIntakeBusy(false);
      setSdWorkflowUiActive(false);
      setLoading(false);
    }
  }

  useSdCardMonitor({
    onRequestSelect: (drive, mode) => {
      void openSdSelector(drive, mode);
    },
    onAutoProcess: (drive, actions) => {
      void runAutoSdWorkflow(drive, actions);
    },
    onRequestDrain: () => scheduleSdQueueDrain(),
  });

  async function handleSdPrimaryAction(drive: string) {
    if (config?.sd_backup_mode === "auto") {
      await runAutoSdWorkflow(drive, settingsSdActions());
      return;
    }
    await openSdSelector(drive, "backup");
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isToggle =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "j";
      if (isToggle) {
        e.preventDefault();
        toggleConsole();
        return;
      }
      if (e.key === "Escape" && consoleOpen) {
        e.preventDefault();
        setConsoleOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleConsole, setConsoleOpen, consoleOpen]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        setSplashStatus(t("app.splash.loadAppInfo"));
        const info = await getAppInfo();
        if (!cancelled) setAppVersion(info.version);
        void getUpdaterInstallHint()
          .then((hint) => {
            if (!cancelled) setUpdaterPlatformHint(hint);
          })
          .catch(() => undefined);

        setSplashStatus(t("app.splash.loadSettings"));
        await loadConfig();
        const loaded = useConfigStore.getState().config;
        if (loaded?.ui_language) {
          await useLocaleStore.getState().setLanguage(
            normalizeUiLanguage(loaded.ui_language),
          );
        }

        setSplashStatus(t("app.splash.checkFfmpeg"));
        const checks = await runStartupChecks(false);
        if (cancelled) return;

        if (checks.hw) setHwInfo(checks.hw);
        setAppVersion(checks.version);
        setSplashStatus(presentStartupCheckMessage(checks.message));

        if (!checks.ok) {
          const ffmpegError = presentStartupFfmpegError(checks.ffmpeg_error);
          const splashErr =
            ffmpegError ?? presentStartupCheckMessage(checks.message);
          setSplashError(splashErr);
          showError(
            ffmpegError ?? tr("app.splash.ffmpegMissing"),
            t("app.ffmpeg.title"),
          );
        } else if (checks.media_warning) {
          showWarning(
            presentLinuxMediaWarning(checks.media_warning) ??
              checks.media_warning,
            t("app.mediaPlayback.title"),
          );
        }

        setSplashStatus(t("app.splash.clearCache"));
        try {
          await cleanupCache({ orphans_only: true });
        } catch (e) {
          // Non-fatal — orphans can linger until next start / manual cleanup.
          console.warn("startup cache sweep failed", e);
        }
        if (cancelled) return;

        setSplashStatus(t("app.splash.ready"));
        if (!cancelled) {
          setReady(true);
          setSplashOpen(false);
          void focusMainWindowAfterUpdate().catch(() => undefined);
        }

        void runUpdateCheck(
          false,
          useConfigStore.getState().config?.beta_updates_enabled ?? false,
        );
      } catch (e) {
        if (cancelled) return;
        const msg = String(e);
        setSplashError(msg);
        setSplashStatus(t("app.splash.startWithErrors"));
        showError(msg, t("app.start.title"));
        setReady(true);
        setSplashOpen(false);
        void focusMainWindowAfterUpdate().catch(() => undefined);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConfig, showError, showWarning]);

  useEffect(() => {
    if (!ready || !config || splashOpen) return;
    if (!config.setup_completed) setSetupWizardOpen(true);
  }, [ready, config, splashOpen]);

  useEffect(() => {
    if (!config?.ui_language) return;
    void useLocaleStore
      .getState()
      .setLanguage(normalizeUiLanguage(config.ui_language));
  }, [config?.ui_language]);

  /** Historie badge: refresh pending/failed count when upload is enabled. */
  useEffect(() => {
    if (!ready || splashOpen || setupWizardOpen) return;
    const uploadOn = Boolean(config?.upload_to_server);
    void refreshPendingUploadCount(uploadOn).catch(() => {});
  }, [
    ready,
    splashOpen,
    setupWizardOpen,
    config?.upload_to_server,
  ]);

  /** Crash recovery: `uploading` without an active slot job → `pending`. */
  useEffect(() => {
    if (!ready || splashOpen || setupWizardOpen) return;
    if (!config?.upload_to_server) return;
    const activeId = useUploadQueueStore.getState().active?.vorgangId ?? null;
    void reconcileStaleUploads(activeId != null ? [activeId] : [])
      .then((n) => {
        if (n <= 0) return;
        useHistoryStore.setState((s) => ({
          vorgaenge: s.vorgaenge.map((row) =>
            row.upload_state === "uploading" &&
            (activeId == null || row.id !== activeId)
              ? { ...row, upload_state: "pending" }
              : row,
          ),
        }));
        void refreshPendingUploadCount(true).catch(() => {});
      })
      .catch(() => {});
  }, [ready, splashOpen, setupWizardOpen, config?.upload_to_server]);

  /** Optional once-per-reconnect toast when uploads are pending (no auto-drain). */
  useEffect(() => {
    if (!ready || splashOpen || setupWizardOpen) {
      serverWasConnectedRef.current = serverConnected;
      return;
    }
    const uploadOn = Boolean(config?.upload_to_server);
    const was = serverWasConnectedRef.current;
    serverWasConnectedRef.current = serverConnected;
    if (!uploadOn) {
      pendingUploadToastArmedRef.current = false;
      return;
    }
    if (!serverConnected) {
      pendingUploadToastArmedRef.current = true;
      return;
    }
    if (!was && serverConnected && pendingUploadToastArmedRef.current) {
      pendingUploadToastArmedRef.current = false;
      const count = useHistoryStore.getState().pendingUploadCount;
      if (count > 0) {
        showPendingUploadsToast(
          t("history.upload.reconnectToastTitle"),
          t("history.upload.reconnectToastBody", { count }),
        );
      }
    }
  }, [
    ready,
    splashOpen,
    setupWizardOpen,
    serverConnected,
    config?.upload_to_server,
    t,
  ]);

  useEffect(() => {
    if (!ready || splashOpen || setupWizardOpen || !config || !serverConnected) return;
    if (config.ams_bridge_url.trim() && config.ams_bridge_token.trim()) return;
    const key = [
      config.server_url,
      config.server_password,
      config.ams_bridge_url,
      config.ams_bridge_token,
      config.ams_bridge_last_ok_url,
    ].join("\0");
    if (amsAutoConnectKeyRef.current === key) return;
    amsAutoConnectKeyRef.current = key;
    void runAmsAutoConnect({ config, interactive: false });
  }, [
    config,
    ready,
    serverConnected,
    setupWizardOpen,
    splashOpen,
  ]);

  useServerHealthPoll(ready && !splashOpen && !setupWizardOpen);
  useAmsHandoffPoll(ready && !splashOpen && !setupWizardOpen);

  useEffect(() => {
    if (!config || defaultsApplied.current) return;
    defaultsApplied.current = true;
    applyDefaultsFromConfig({
      ort: config.ort,
      tandemmaster: config.tandemmaster,
      videospringer: config.videospringer,
      gast_name: config.gast_name,
      outside_video: config.outside_video,
    });
  }, [config, applyDefaultsFromConfig]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<EncodeProgress>("encode-progress", (event) => {
      if (sessionCancelRequestedRef.current) return;
      const p = event.payload;

      if (p.task_id != null && p.task_id > 0) {
        // Per-clip bars only — overall % comes exclusively from overall events
        // (avoids flicker when task-average and remapped stage % race).
        setTaskProgress((prev) => {
          const next = [...prev];
          const idx = next.findIndex((t) => t.taskId === p.task_id);
          const prevStatus = idx >= 0 ? next[idx].status : "";
          const entry: TaskProgressState = {
            taskId: p.task_id!,
            percent: applyMonotonicPercent(idx >= 0 ? next[idx].percent : 0, p.percent),
            status: resolveProgressLabel(p.status, prevStatus),
          };
          if (idx >= 0) next[idx] = entry;
          else next.push(entry);
          next.sort((a, b) => a.taskId - b.taskId);
          return next;
        });
        setStatus((prev) => {
          if (
            prev &&
            !/^(continue|end|starting|in arbeit…)$/i.test(prev.trim()) &&
            prev !== tr("common.status.inProgress")
          ) {
            return prev;
          }
          return formatOverallProgressLabel(p.status, prev);
        });
      } else {
        setPercent((prev) => applyMonotonicPercent(prev, p.percent));
        const label = resolveProgressLabel(p.status, undefined);
        setStatus((prev) => formatOverallProgressLabel(p.status, prev));
        if (shouldClearTaskProgress(p.status) || shouldClearTaskProgress(label)) {
          setTaskProgress([]);
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<IntroMuxFallbackPayload>("intro-mux-fallback-required", (event) => {
      const p = event.payload;
      setIntroMuxFallback({
        reason: p.reason ?? "",
        timeoutSecs: p.timeout_secs > 0 ? p.timeout_secs : 15,
      });
      setStatus(t("progress.rust.streamCopyFailedWaiting"));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<BodyConcatFallbackPayload>("body-concat-fallback-required", (event) => {
      const p = event.payload;
      setBodyConcatFallback({
        reason: p.reason ?? "",
      });
      setStatus(
        /compatible\s*path/i.test(p.reason ?? "")
          ? t("progress.status.compatiblePathWaiting")
          : t("progress.status.fastPathWaiting"),
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ReencodeConfirmPayload>("reencode-confirm-required", (event) => {
      const p = event.payload;
      setReencodeConfirm({
        kind: p.kind ?? "",
        reason: p.reason ?? "",
        params: p.params ?? {},
        recommended: p.recommended ?? defaultEncodeProfile(),
        presets: p.presets ?? [],
      });
      setStatus(t("progress.rust.reencodeWaiting"));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UpdateInstallProgress>("update-install-progress", (event) => {
      setUpdateInstallProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function onIntroMuxChoice(choice: IntroMuxFallbackChoice) {
    setIntroMuxFallback(null);
    setStatus(
      choice === "without_intro"
        ? t("progress.rust.exportWithoutIntro")
        : t("app.intro.encodeAgain"),
    );
    try {
      await resolveIntroMuxFallback(choice);
    } catch (e) {
      showError(String(e), t("app.intro.decisionTitle"));
    }
  }

  async function onBodyConcatChoice(choice: BodyConcatFallbackChoice) {
    setBodyConcatFallback(null);
    setStatus(
      choice === "use_legacy"
        ? t("progress.status.legacyConcat")
        : t("app.concat.cancelled"),
    );
    try {
      await resolveBodyConcatFallback(choice);
    } catch (e) {
      showError(String(e), t("app.concat.decisionTitle"));
    }
  }

  async function onReencodeChoice(result: ReencodeConfirmResult) {
    setReencodeConfirm(null);
    setStatus(
      result.choice === "proceed"
        ? t("progress.status.reencode")
        : t("progress.default.cancelled"),
    );
    try {
      await resolveReencodeConfirm(
        result.choice,
        result.choice === "proceed" ? result.profile : null,
      );
    } catch (e) {
      showError(String(e), t("dialogs.reencode.title"));
    }
  }

  useEffect(() => {
    bindUploadSlotRunner({
      runJob: (job) => uploadSlotRunnerRef.current(job),
    });
  }, []);

  uploadSlotRunnerRef.current = async (job) => {
    const persistUploadState = async (
      state: "pending" | "uploading" | "done" | "failed" | "cancelled",
    ) => {
      // Append SMB must not flip the parent vorgang's Erst-Upload state.
      if (job.source === "append") return;
      if (job.vorgangId == null && !job.correlationId) return;
      try {
        await setVorgangUploadState(state, {
          vorgangId: job.vorgangId,
          correlationId: job.correlationId,
        });
        if (job.vorgangId != null) {
          useHistoryStore.getState().patchVorgang(job.vorgangId, (row) => ({
            ...row,
            upload_state: state,
          }));
        }
      } catch (e) {
        console.error("upload_state update failed:", e);
      }
    };

    const folderLabel =
      job.guestLabel?.trim() ||
      job.folderName?.trim() ||
      null;

    setServerPhase("uploading");
    setUploadProgress(null);
    uploadProgressActiveRef.current = true;
    uploadCancelRequestedRef.current = false;
    useUploadQueueStore.getState().setCancelPhase(null);
    // Background upload must not touch session percent/status (Dual-Panel 37.4).
    await persistUploadState("uploading");

    try {
      await resetUploadSlotCancel();
      // Cancel may have landed between enqueue and reset — honor it.
      if (uploadCancelRequestedRef.current) {
        await persistUploadState("cancelled");
        setServerPhase("connected");
        setUploadProgress(null);
        uploadProgressActiveRef.current = false;
        useUploadQueueStore.getState().setCancelPhase(null);
        return "cancelled";
      }
      const uploaded = await uploadToServer(job.localDir, undefined, {
        correlation_id: job.correlationId,
        folder_name: job.folderName,
      });
      if (uploadCancelRequestedRef.current) {
        await persistUploadState("cancelled");
        setServerPhase("connected");
        setUploadProgress(null);
        uploadProgressActiveRef.current = false;
        useUploadQueueStore.getState().setCancelPhase(null);
        return "cancelled";
      }
      await persistUploadState("done");
      if (job.vorgangId != null && job.correlationId?.trim()) {
        void getHandoffStatus(
          job.correlationId,
          job.localDir,
          job.vorgangId,
        )
          .then((status) => {
            if (!status || job.vorgangId == null) return;
            useHistoryStore
              .getState()
              .patchVorgang(job.vorgangId, (row) =>
                applyHandoffToEntry(row, status),
              );
          })
          .catch(() => {});
      }
      setServerPhase("connected");
      if (!job.quietSuccess) {
        showBackgroundUploadDoneToast({
          title: t("app.upload.bgDoneTitle"),
          message:
            folderLabel ||
            uploaded.remote_path ||
            uploaded.message ||
            undefined,
        });
      }
      return "ok";
    } catch (uploadErr) {
      if (isCancellationError(uploadErr) || uploadCancelRequestedRef.current) {
        await persistUploadState("cancelled");
        setServerPhase("connected");
        setUploadProgress(null);
        uploadProgressActiveRef.current = false;
        useUploadQueueStore.getState().setCancelPhase(null);
        if (!job.quietSuccess) {
          showWarning(
            t("app.upload.bgCancelled"),
            t("app.upload.title"),
          );
        }
        return "cancelled";
      }
      await persistUploadState("failed");
      setServerPhase("error");
      useUploadQueueStore.getState().setCancelPhase(null);
      if (!job.quietSuccess) {
        const detail = String(uploadErr).trim();
        showBackgroundUploadFailToast({
          title: t("app.upload.bgFailTitle"),
          message: detail
            ? t("app.upload.bgFailMessage", { detail: `${detail}.` })
            : t("app.upload.bgFailHint"),
        });
      }
      return "failed";
    } finally {
      uploadProgressActiveRef.current = false;
      setUploadProgress(null);
      useUploadQueueStore.getState().setCancelPhase(null);
      void refreshPendingUploadCount(
        Boolean(useConfigStore.getState().config?.upload_to_server),
      ).catch(() => {});
    }
  };

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenPhase: (() => void) | undefined;
    // Upload channel only — never write session percent/status (concurrent Create).
    listen<UploadProgressEvent>("upload-progress", (event) => {
      if (!uploadProgressActiveRef.current || uploadCancelRequestedRef.current) return;
      setUploadProgress(event.payload);
    }).then((fn) => {
      unlistenProgress = fn;
    });
    listen<{ phase: string }>("upload-slot-phase", (event) => {
      if (event.payload.phase === "cleanup") {
        useUploadQueueStore.getState().setCancelPhase("cleanup");
      }
    }).then((fn) => {
      unlistenPhase = fn;
    });
    return () => {
      unlistenProgress?.();
      unlistenPhase?.();
    };
  }, [setUploadProgress]);

  const resetProgress = useCallback(() => {
    setPercent(0);
    setStatus("");
    setTaskProgress([]);
    setCreateJobPlan(null);
    setCreateFailed(false);
  }, []);

  useEffect(() => {
    if (appendActive && !appendWasActiveRef.current) {
      resetProgress();
      setStatus(t("app.append.starting"));
      setPercent(1);
    }
    appendWasActiveRef.current = appendActive;
  }, [appendActive, resetProgress, t]);

  async function ensureSpeicherort(forcePick = false): Promise<string | null> {
    const current = config?.speicherort?.trim() ?? "";
    if (current && !forcePick) return current;

    const selected = await open({
      directory: true,
      multiple: false,
      title: t("app.storage.pickTitle"),
      defaultPath: current || undefined,
    });
    if (typeof selected !== "string" || !selected) {
      if (!forcePick) showWarning(t("app.storage.noneChosen"), t("app.storage.title"));
      return forcePick ? current || null : null;
    }
    if (!config) {
      showError(t("app.storage.notLoaded"));
      return null;
    }
    const saved = await persistConfig({ ...config, speicherort: selected });
    if (!saved) {
      showError(t("app.storage.saveFailed"));
      return null;
    }
    showSuccess(t("app.storage.saved", { path: selected }), t("app.storage.title"));
    return selected;
  }

  async function openSpeicherortFolder() {
    const path = config?.speicherort?.trim() ?? "";
    if (!path) {
      showError(t("app.storage.notSet"));
      return;
    }
    try {
      await revealItemInDir(path);
    } catch (e) {
      showError(String(e), t("app.storage.title"));
    }
  }

  function onLowMediaChoice(choice: LowMediaConfirmChoice) {
    const pending = lowMediaConfirm;
    setLowMediaConfirm(null);
    if (!pending) return;
    const sig = lowMediaSignature({
      kunde,
      videoCount: pending.videoCount,
      photoCount: pending.photoCount,
    });
    // Once per Vorgang until media/products change (Back or Proceed).
    lowMediaAckRef.current = sig;
    if (choice === "proceed") {
      void runCreateJob();
    }
  }

  function onFolderConflictChoice(choice: FolderConflictConfirmChoice) {
    const pending = folderConflictConfirm;
    setFolderConflictConfirm(null);
    if (!pending) return;
    if (choice === "back") {
      replaceExistingDirRef.current = false;
      return;
    }
    const sig = folderConflictSignature({
      exists: true,
      is_empty: false,
      folder_name: pending.folderName,
      folder_path: pending.folderPath,
      has_marker: pending.hasMarker,
      video_file_count: pending.videoFileCount,
      photo_file_count: pending.photoFileCount,
      other_file_count: pending.otherFileCount,
      total_file_count: pending.totalFileCount,
    });
    folderConflictAckRef.current = sig;
    replaceExistingDirRef.current = true;
    void continueCreateAfterFolderConflict();
  }

  function onOfflineCreateChoice(choice: OfflineCreateConfirmChoice) {
    setOfflineCreateConfirm(null);
    if (choice === "back") {
      offlineCreateAckRef.current = false;
      return;
    }
    offlineCreateAckRef.current = true;
    void startCreate();
  }

  /** After folder replace ack: low-media soft confirm, then create. */
  async function continueCreateAfterFolderConflict() {
    if (busy || appendActive || sdWorkflowUiActive || loading || qrScanBusy)
      return;
    const paths = videoList.map((v) => v.path);
    const photos = photoList.map((p) => p.path);
    const lowMediaInput = {
      kunde,
      videoCount: paths.length,
      photoCount: photos.length,
    };
    const lowMedia = shouldWarnLowMedia(lowMediaInput);
    const sig = lowMediaSignature(lowMediaInput);
    if (lowMedia.warn && lowMediaAckRef.current !== sig) {
      setLowMediaConfirm({
        reasons: lowMedia.reasons,
        videoCount: lowMedia.videoCount,
        photoCount: lowMedia.photoCount,
        uploadToServer: Boolean(config?.upload_to_server),
      });
      return;
    }
    await runCreateJob();
  }

  async function startCreate() {
    if (busy || appendActive || sdWorkflowUiActive || loading || qrScanBusy)
      return;
    const speicher = await ensureSpeicherort();
    if (!speicher) return;

    const paths = videoList.map((v) => v.path);
    const photos = photoList.map((p) => p.path);
    const wmPhotos = [...watermarkPhotoIndices].sort((a, b) => a - b);

    const validation = await validateCreateJob(
      kunde,
      paths,
      photos,
      wmPhotos,
      config?.oldschool_mode,
    );
    if (!validation.valid) {
      showWarning(
        validation.errors.map(translateValidationHint).join("\n"),
        t("create.validation.validation"),
      );
      return;
    }

    if (config?.upload_to_server && !serverConnected) {
      if (!offlineCreateAckRef.current) {
        setOfflineCreateConfirm({ open: true });
        return;
      }
    } else {
      offlineCreateAckRef.current = false;
    }

    // Soft folder-conflict confirm before low-media / setBusy (not on Append).
    try {
      const probe = await probeCreateOutputFolder(kunde);
      if (shouldWarnFolderConflict(probe)) {
        const fSig = folderConflictSignature(probe);
        if (folderConflictAckRef.current !== fSig) {
          setFolderConflictConfirm(
            toFolderConflictConfirmState(
              probe,
              Boolean(config?.upload_to_server),
            ),
          );
          return;
        }
        replaceExistingDirRef.current = true;
      } else {
        replaceExistingDirRef.current = false;
        folderConflictAckRef.current = null;
      }
    } catch (e) {
      showError(String(e), t("dialogs.folderConflict.title"));
      return;
    }

    // Soft low-media confirm before setBusy / encode / reencode (not on Append).
    const lowMediaInput = {
      kunde,
      videoCount: paths.length,
      photoCount: photos.length,
    };
    const lowMedia = shouldWarnLowMedia(lowMediaInput);
    const sig = lowMediaSignature(lowMediaInput);
    if (lowMedia.warn && lowMediaAckRef.current !== sig) {
      setLowMediaConfirm({
        reasons: lowMedia.reasons,
        videoCount: lowMedia.videoCount,
        photoCount: lowMedia.photoCount,
        uploadToServer: Boolean(config?.upload_to_server),
      });
      return;
    }

    await runCreateJob();
  }

  async function runCreateJob() {
    if (busy || appendActive || sdWorkflowUiActive || loading || qrScanBusy)
      return;

    const paths = videoList.map((v) => v.path);
    const photos = photoList.map((p) => p.path);
    const wmPhotos = [...watermarkPhotoIndices].sort((a, b) => a - b);
    const replaceExistingDir = replaceExistingDirRef.current;

    setBusy(true);
    sessionCancelRequestedRef.current = false;
    // Keep uploadProgressActiveRef alone — Create must not gate the upload channel.
    resetProgress();
    const encodingSig = previewEncodingSignature(
      Boolean(config?.intro_enabled ?? false),
      config?.dauer ?? 5,
      config?.intro_mux_mode ?? "reencode",
    );
    const canReusePreview = getPreviewReusePlan(
      videoList,
      kunde,
      encodingSig,
    ).canReuse;
    setCreateJobPlan(
      buildCreateJobPlan({
        kunde,
        videoCount: paths.length,
        photoCount: photos.length,
        watermarkPhotoCount: wmPhotos.length,
        uploadToServer: Boolean(config?.upload_to_server),
        manualEntryMode: config?.manual_entry_mode,
        reusePreview: canReusePreview,
      }),
    );
    setCreateFailed(false);
    setStatus(t("create.job.creating"));
    setPercent(1);
    try {
      const codec = (config?.video_codec ?? "auto") as "auto" | "h264" | "h265";
      const res: CreateJobResult = await createJob(
        kunde,
        paths,
        photos,
        {
          watermark_clip_index: watermarkClipIndex,
          watermark_photo_indices: wmPhotos,
          dauer: config?.dauer ?? 5,
          intro_enabled: config?.intro_enabled ?? false,
          video_codec: codec === "h265" || codec === "h264" ? codec : "auto",
          crf: config?.preview_encode_crf ?? 18,
          parallel_enabled: config?.parallel_processing_enabled ?? true,
          intro_mux_mode: config?.intro_mux_mode ?? "reencode",
          body_concat_mode: config?.body_concat_mode ?? "fast",
          hw_accel_enabled: config?.hardware_acceleration_enabled ?? false,
          reuse_preview_path: canReusePreview ? cachedPreviewPath : null,
          reuse_preview_fingerprint: canReusePreview
            ? cachedPreviewFingerprint
            : null,
          replace_existing_dir: replaceExistingDir,
        },
        kunde.form_mode === "kunde" ? qrPreview : null,
      );

      let uploadNote: string | null = null;
      let serverUploaded = false;
      let uploadDeferred = false;
      let uploadInProgress = false;
      let uploadJobId: string | null = null;
      let detachedUpload = false;
      const vorgangId = res.vorgang_id ?? null;
      const correlationId = res.correlation_id?.trim() || null;

      if (config?.upload_to_server) {
        if (!serverConnected) {
          // Soft-ack offline create: keep upload_state=pending; no SMB this run.
          uploadDeferred = true;
          uploadNote = t("create.success.uploadPendingHint");
        } else {
          const guestLabel =
            [kunde.vorname, kunde.nachname].filter(Boolean).join(" ").trim() ||
            res.base_filename?.trim() ||
            null;
          uploadJobId = `create-${vorgangId ?? correlationId ?? Date.now()}`;
          uploadInProgress = true;
          uploadNote = null;
          detachedUpload = true;

          void enqueueUpload({
            id: uploadJobId,
            source: "create",
            localDir: res.base_output_dir,
            folderName: res.base_filename?.trim() || null,
            correlationId,
            vorgangId,
            guestLabel,
            tandemmaster: kunde.tandemmaster.trim() || null,
            videospringer: kunde.videospringer.trim() || null,
            quietSuccess: false,
          }).then((result) => {
            setCreateSuccess((prev) => {
              if (!prev || prev.uploadJobId !== uploadJobId) return prev;
              if (result === "ok") {
                return {
                  ...prev,
                  uploadInProgress: false,
                  serverUploaded: true,
                  uploadDeferred: false,
                  uploadNote: guestLabel,
                };
              }
              if (result === "cancelled") {
                return {
                  ...prev,
                  uploadInProgress: false,
                  serverUploaded: false,
                  uploadDeferred: false,
                  uploadNote: t("app.upload.bgCancelled"),
                };
              }
              return {
                ...prev,
                uploadInProgress: false,
                serverUploaded: false,
                uploadDeferred: false,
                uploadNote: t("app.upload.failedNote"),
              };
            });
          });
        }
      }

      setCreateSuccess({
        result: res,
        serverUploaded,
        uploadDeferred,
        uploadInProgress,
        uploadJobId,
        uploadNote,
        vorname: kunde.vorname,
        nachname: kunde.nachname,
      });
      setPercent(100);
      setStatus(t("create.job.done"));
      setTaskProgress([]);
      folderConflictAckRef.current = null;
      replaceExistingDirRef.current = false;
      offlineCreateAckRef.current = false;
      if (config?.upload_to_server) {
        void refreshPendingUploadCount(true).catch(() => {});
      }

      if (config?.auto_clear_files_after_creation) {
        videoCuts.clearUndoState();
        clearVideos({ deleteFiles: false });
        clearPhotos({ deleteFiles: false });
        clearPreviewCache();
        void clearWorkingSession();
        resetSession({
          tandemmaster: config.keep_tandemmaster_on_session_reset,
          videospringer: config.keep_videospringer_on_session_reset,
          tandemmasterFixed: config.tandemmaster,
          videospringerFixed: config.videospringer,
        });
        clearCreateReadyPulse();
        lowMediaAckRef.current = null;
        folderConflictAckRef.current = null;
        replaceExistingDirRef.current = false;
        offlineCreateAckRef.current = false;
      }

      // Encode finished; slot runner owns cancel flag while SMB runs.
      if (!detachedUpload) {
        sessionCancelRequestedRef.current = false;
        void resetWorkflowCancel().catch(() => {});
      }
    } catch (e) {
      if (isCancellationError(e)) {
        setTaskProgress([]);
        setPercent(0);
        setStatus(t("progress.default.cancelled"));
        showWarning(t("create.job.cancelled"));
      } else {
        setCreateFailed(true);
        showError(presentAmsUserMessage(String(e)));
      }
      sessionCancelRequestedRef.current = false;
      void resetWorkflowCancel().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function cancelSessionWork() {
    const slotState = useUploadQueueStore.getState();
    const slotActive = slotState.active !== null;
    const cancellingQr = qrScanBusy && !busy && !appendActive && !slotActive;
    sessionCancelRequestedRef.current = true;

    // Never cancel the upload slot from the session panel.
    try {
      await cancelEncode();
      if (!cancellingQr && (busy || appendActive)) {
        setTaskProgress([]);
        setPercent(0);
        setStatus(t("progress.default.cancelled"));
      }
    } catch (e) {
      if (!isCancellationError(e)) showError(String(e));
    }
  }

  async function cancelBackgroundUpload() {
    const slotState = useUploadQueueStore.getState();
    const slotActive = slotState.active !== null;
    const queueWaiting = slotState.queue.length > 0;
    uploadCancelRequestedRef.current = true;

    if (slotActive) {
      useUploadQueueStore.getState().setCancelPhase("cancelling");
      try {
        await cancelUploadSlot();
      } catch (e) {
        if (!isCancellationError(e)) showError(String(e));
      }
      return;
    }

    if (queueWaiting) {
      cancelQueuedUploads();
    }
    uploadProgressActiveRef.current = false;
  }

  /** Historie „Upload nachholen“ — shared background upload slot (Phase 37.3). */
  async function retryVorgangUpload(
    entry: VorgangEntry,
    opts?: { omittedFileCount?: number; includedExtraCount?: number },
  ) {
    await runVorgangUploadAttempt(entry, {
      quietSuccess: false,
      omittedFileCount: opts?.omittedFileCount,
      includedExtraCount: opts?.includedExtraCount,
    });
    void refreshPendingUploadCount(Boolean(config?.upload_to_server)).catch(
      () => {},
    );
  }

  /** Quiet SMB retry for bulk phase 1 / phase 2 (returns upload outcome). */
  async function retryVorgangUploadForBulk(
    entry: VorgangEntry,
    opts?: VorgangUploadRetryOptions,
  ): Promise<"ok" | "failed" | "cancelled"> {
    const result = await runVorgangUploadAttempt(entry, {
      quietSuccess: true,
      omittedFileCount: opts?.omittedFileCount,
      includedExtraCount: opts?.includedExtraCount,
    });
    void refreshPendingUploadCount(Boolean(config?.upload_to_server)).catch(
      () => {},
    );
    return result;
  }

  /**
   * Phase 31.6 / 37.3: scan → phase 1 (ready via FIFO queue) → optional phase 2.
   * Session stays unlocked; only the shared upload slot serializes SMB.
   */
  async function retryVorgangUploadsBulk(scan: BulkUploadScanResult) {
    const summary = createEmptyBulkUploadSummary();
    for (const entry of scan.blocked) {
      summary.blocked += 1;
      summary.blockedItems.push(bulkSummaryItemFromScanEntry(entry));
    }

    const readyEntries = scan.ready;
    if (readyEntries.length === 0 && scan.needsDecision.length === 0) {
      setBulkUploadSummary(summary);
      return;
    }

    uploadCancelRequestedRef.current = false;

    const pendingResults: Promise<"ok" | "failed" | "cancelled">[] = [];
    let enqueued = 0;

    for (let i = 0; i < readyEntries.length; i++) {
      const entry = readyEntries[i]!;
      if (!useServerStore.getState().connected) {
        summary.aborted = true;
        summary.remaining =
          readyEntries.length - i + scan.needsDecision.length;
        break;
      }
      if (uploadCancelRequestedRef.current) {
        summary.aborted = true;
        summary.remaining =
          readyEntries.length - i + scan.needsDecision.length;
        break;
      }

      try {
        const pf = await preflightVorgangUpload(entry.id);
        const cls = classifyBulkPreflight(pf);
        if (cls.bucket !== "ready") {
          summary.skipped += 1;
          summary.skippedItems.push({
            guest: entry.gast,
            vorgangId: entry.id,
            reasonCode: primaryPreflightReasonCode(cls.reasonCodes),
          });
          continue;
        }
      } catch {
        summary.skipped += 1;
        summary.skippedItems.push({
          guest: entry.gast,
          vorgangId: entry.id,
          reasonCode: "preflight_error",
        });
        continue;
      }

      enqueued += 1;
      pendingResults.push(
        runVorgangUploadAttempt(entry, { quietSuccess: true }),
      );
    }

    if (pendingResults.length > 0) {
      const results = await Promise.all(pendingResults);
      for (const result of results) {
        if (result === "ok") {
          summary.ok += 1;
        } else if (result === "cancelled") {
          summary.aborted = true;
        } else {
          summary.failed += 1;
        }
      }
      if (summary.aborted || !useServerStore.getState().connected) {
        summary.aborted = true;
        // Only jobs never enqueued + phase-2 remain; enqueued ones already settled.
        summary.remaining =
          readyEntries.length - enqueued + scan.needsDecision.length;
      }
    }

    uploadCancelRequestedRef.current = false;
    void refreshPendingUploadCount(Boolean(config?.upload_to_server)).catch(
      () => {},
    );

    if (scan.needsDecision.length > 0 && !summary.aborted) {
      setBulkPhase2Session({ entries: scan.needsDecision, summary });
      setProcessedOpen(true);
      return;
    }

    setBulkUploadSummary(summary);
  }

  function completeBulkPhase2(finalSummary: BulkUploadSummary) {
    setBulkPhase2Session(null);
    setBulkUploadSummary(finalSummary);
  }

  /** Shared SMB attempt used by single retry and bulk (Phase 31.2 / 31.3 / 37.3 slot). */
  async function runVorgangUploadAttempt(
    entry: VorgangEntry,
    opts: {
      quietSuccess: boolean;
      omittedFileCount?: number;
      includedExtraCount?: number;
    },
  ): Promise<"ok" | "failed" | "cancelled"> {
    const guestLabel =
      entry.gast?.trim() || entry.base_filename?.trim() || null;

    // Outcomes stay on the upload channel (toasts / fail-hold / Success note).
    // Do not write session percent/status — Create may be running in parallel.
    return enqueueUpload({
      source: opts.quietSuccess ? "bulk" : "history",
      localDir: entry.base_output_dir,
      folderName: entry.base_filename?.trim() || null,
      correlationId: entry.correlation_id?.trim() || null,
      vorgangId: entry.id,
      guestLabel,
      tandemmaster: entry.tandemmaster?.trim() || null,
      videospringer: entry.videospringer?.trim() || null,
      quietSuccess: opts.quietSuccess,
    });
  }

  async function handleSelectorConfirm(paths: string[], actions: SdWorkflowActions) {
    const drive = useSdStore.getState().selectorDrive;
    if (!drive) return;
    try {
      await runSdWorkflow(drive, paths, actions, {
        onStart: () => {
          setSdWorkflowUiActive(true);
          closeSelector();
        },
      });
    } finally {
      setSdWorkflowUiActive(false);
    }
  }

  async function handleSelectorProceedAll(actions: SdWorkflowActions) {
    const drive = useSdStore.getState().selectorDrive;
    if (!drive) return;
    try {
      await runSdWorkflow(drive, null, actions, {
        onStart: () => {
          setSdWorkflowUiActive(true);
          closeSelector();
        },
      });
    } finally {
      setSdWorkflowUiActive(false);
    }
  }

  async function handleSessionReset(): Promise<boolean> {
    if (busy || appendActive || loading || sdWorkflowUiActive || qrScanBusy) {
      showWarning(
        t("app.session.resetBlocked"),
        t("common.actions.reset"),
      );
      return false;
    }
    clearSdQueue();
    videoCuts.clearUndoState();
    clearVideos({ deleteFiles: false });
    clearPhotos({ deleteFiles: false });
    clearPreviewCache();
    await clearWorkingSession();
    resetSession({
      tandemmaster: config?.keep_tandemmaster_on_session_reset,
      videospringer: config?.keep_videospringer_on_session_reset,
      tandemmasterFixed: config?.tandemmaster,
      videospringerFixed: config?.videospringer,
    });
    clearCreateReadyPulse();
    lowMediaAckRef.current = null;
    setLowMediaConfirm(null);
    folderConflictAckRef.current = null;
    replaceExistingDirRef.current = false;
    setFolderConflictConfirm(null);
    offlineCreateAckRef.current = false;
    setOfflineCreateConfirm(null);
    showSessionResetToast(
      t("common.actions.reset"),
      t("app.session.resetDone"),
    );
    return true;
  }

  return (
    <div className="flex h-full min-h-screen flex-col text-foreground">
      <SplashScreen
        open={splashOpen}
        status={splashStatus}
        version={appVersion}
        error={splashError}
      />

      <AppShell
        ready={ready}
        appVersion={appVersion}
        postUpdateHintEnabled={ready && !splashOpen && !setupWizardOpen}
        hwInfo={hwInfo}
        busy={busy}
        sdWorkflowUiActive={sdWorkflowUiActive}
        mediaTab={mediaTab}
        setMediaTab={setMediaTab}
        percent={percent}
        status={status}
        taskProgress={taskProgress}
        createJobPlan={createJobPlan}
        createFailed={createFailed}
        createSuccessOpen={createSuccess !== null}
        cutterOpen={cutterOpen}
        onBusyChange={setBusy}
        onStatus={setStatus}
        onProgressReset={resetProgress}
        onProgressComplete={(finalStatus) => {
          setPercent(100);
          setStatus(finalStatus);
        }}
        onCancelSession={() => void cancelSessionWork()}
        onCancelUpload={() => void cancelBackgroundUpload()}
        onResetProgress={resetProgress}
        onOpenCutter={(path, durationSecs) => {
          setCutterPath(path);
          setCutterDuration(durationSecs);
          setCutterOpen(true);
        }}
        onOpenPhotoEditor={(path) => {
          setPhotoEditorPath(path);
          setPhotoEditorOpen(true);
        }}
        onStartCreate={() => void startCreate()}
        onEnsureSpeicherort={ensureSpeicherort}
        onOpenSpeicherortFolder={() => void openSpeicherortFolder()}
        onOpenSdDrive={(drive) => void openSdDriveFromHeader(drive)}
        onSdPrimaryAction={(drive) => void handleSdPrimaryAction(drive)}
        onOpenHistory={() => setProcessedOpen(true)}
        onSessionReset={handleSessionReset}
        onOpenSettings={() => setSettingsOpen(true)}
        onSessionCleared={() => {
          videoCuts.clearUndoState();
        }}
        videoCuts={videoCuts}
        photoEdits={photoEdits}
      />

      <AppDialogs
        config={config}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        setupWizardOpen={setupWizardOpen}
        onSetupComplete={() => {
          setSetupWizardOpen(false);
          const cfg = useConfigStore.getState().config;
          if (!cfg) return;
          applyDefaultsFromConfig({
            ort: cfg.ort,
            tandemmaster: cfg.tandemmaster,
            videospringer: cfg.videospringer,
            gast_name: cfg.gast_name,
            outside_video: cfg.outside_video,
          });
        }}
        updateDialogOpen={updateDialogOpen}
        versionInstall={versionInstall}
        appVersion={appVersion}
        updateInstalling={updateInstalling}
        updateInstallProgress={updateInstallProgress}
        installBlockedReason={installBlockedReason}
        updaterPlatformHint={updaterPlatformHint}
        onRequestUpdateCheck={(includeBeta) =>
          void runUpdateCheck(true, includeBeta)
        }
        onRequestVersionSwitch={openVersionSwitchDialog}
        onAfterFactoryReset={() => {
          setSettingsOpen(false);
          setSetupWizardOpen(true);
        }}
        onInstallVersion={() => void runInstallVersion()}
        onCancelInstallVersion={() => void cancelInstallVersion()}
        onUpdateLater={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
        onUpdateClose={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
        processedOpen={processedOpen}
        setProcessedOpen={setProcessedOpen}
        onRetryVorgangUpload={(entry, opts) => void retryVorgangUpload(entry, opts)}
        onBulkRetryUploads={(scan) => void retryVorgangUploadsBulk(scan)}
        bulkPhase2Session={bulkPhase2Session}
        onBulkPhase2Complete={completeBulkPhase2}
        onBulkPhase2Upload={(entry, opts) =>
          retryVorgangUploadForBulk(entry, opts)
        }
        bulkUploadSummary={bulkUploadSummary}
        onBulkUploadSummaryClose={() => setBulkUploadSummary(null)}
        settingsSdActions={settingsSdActions}
        onSdSelectorClose={() => {
          sdEnrichGenRef.current += 1;
          closeSelector();
          scheduleSdQueueDrain();
        }}
        onSdSelectorConfirm={(paths, actions) => void handleSelectorConfirm(paths, actions)}
        onSdSelectorProceedAll={(actions) => void handleSelectorProceedAll(actions)}
        onSdSelectorRefresh={() => {
          const drive = useSdStore.getState().selectorDrive;
          const mode = useSdStore.getState().selectorMode;
          if (!drive) return;
          void openSdSelector(
            drive,
            mode === "size_limit" ? "size_limit" : "backup",
          );
        }}
        cutterOpen={cutterOpen}
        cutterPath={cutterPath}
        cutterDuration={cutterDuration}
        onCutterClose={() => {
          setCutterOpen(false);
          setCutterPath(null);
        }}
        onCutterComplete={(result: VideoCutterResult) => {
          if (!cutterPath || result.action === "cancel") return;
          const path = cutterPath;
          if (result.action === "apply_trim") {
            void videoCuts.applyTrim(path, result.startMs, result.endMs, {
              onBusyChange: setBusy,
              onProgressReset: resetProgress,
              onStatus: setStatus,
            });
          } else if (result.action === "apply_split") {
            void videoCuts.applySplit(path, result.splitMs, {
              onBusyChange: setBusy,
              onProgressReset: resetProgress,
              onStatus: setStatus,
            });
          } else if (result.action === "apply_rotate") {
            void videoCuts.applyRotate(path, result.degrees, {
              onBusyChange: setBusy,
              onProgressReset: resetProgress,
              onStatus: setStatus,
            });
          }
        }}
        photoEditorOpen={photoEditorOpen}
        photoEditorPath={photoEditorPath}
        onPhotoEditorClose={() => {
          setPhotoEditorOpen(false);
          setPhotoEditorPath(null);
        }}
        onPhotoEditorComplete={(result: PhotoEditorResult) => {
          if (!photoEditorPath || result.action === "cancel") return;
          if (result.action === "apply_edits") {
            void photoEdits.applyEdits(
              photoEditorPath,
              {
                degrees: result.degrees,
                crop: result.crop,
                order: result.order,
              },
              {
                onBusyChange: setBusy,
                onProgressReset: resetProgress,
                onStatus: setStatus,
              },
            );
          }
        }}
        dialogKind={dialogKind}
        dialogTitle={dialogTitle}
        dialogMessage={dialogMessage}
        dialogAutoCloseSecs={dialogAutoCloseSecs}
        dialogVariant={dialogVariant}
        dialogHighlight={dialogHighlight}
        dialogActions={dialogActions}
        dialogQrPreview={dialogQrPreview}
        dialogPrimaryAction={dialogPrimaryAction}
        dialogConfirm={dialogConfirm}
        dialogChoices={dialogChoices}
        dialogPrompt={dialogPrompt}
        closeDialog={closeDialog}
        openSettings={openSettings}
        onSuccessClose={() => {
          closeDialog();
          scheduleSdQueueDrain();
        }}
        createSuccess={createSuccess}
        onCreateSuccessClose={() => setCreateSuccess(null)}
        introMuxFallback={introMuxFallback}
        onIntroMuxChoice={onIntroMuxChoice}
        bodyConcatFallback={bodyConcatFallback}
        onBodyConcatChoice={onBodyConcatChoice}
        reencodeConfirm={reencodeConfirm}
        onReencodeChoice={onReencodeChoice}
        lowMediaConfirm={lowMediaConfirm}
        onLowMediaChoice={onLowMediaChoice}
        folderConflictConfirm={folderConflictConfirm}
        onFolderConflictChoice={onFolderConflictChoice}
        offlineCreateConfirm={offlineCreateConfirm}
        onOfflineCreateChoice={onOfflineCreateChoice}
        loading={loading}
        sdWorkflowUiActive={sdWorkflowUiActive}
        loadingMessage={loadingMessage}
        sessionBusy={busy}
      />

      <QuitUploadConfirmDialog
        open={quitUploadConfirm.open}
        onChoose={(choice) => {
          quitUploadConfirm.closeConfirm();
          if (choice === "quit") {
            void onConfirmQuit();
          } else {
            onConfirmStay();
          }
        }}
      />
    </div>
  );
}

export default App;
