import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CloudUpload,
  ExternalLink,
  Film,
  FolderClock,
  FolderOpen,
  ImageIcon,
  RotateCcw,
} from "lucide-react";
import { MediaDropZone } from "./components/MediaDropZone";
import { WorkflowProgressPanel } from "./components/WorkflowProgressPanel";
import { MediaListPanel } from "./components/MediaListPanel";
import { VideoPreview } from "./components/VideoPreview";
import { PhotoPreview } from "./components/PhotoPreview";
import { PhotoEditor, type PhotoEditorResult } from "./components/PhotoEditor";
import { VideoCutter, type VideoCutterResult } from "./components/VideoCutter";
import { CustomerForm, CustomerSessionStrip } from "./components/CustomerForm";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { SetupWizard } from "./components/SetupWizard";
import { ErrorDialog } from "./components/ErrorDialog";
import { SuccessDialog } from "./components/SuccessDialog";
import {
  CreateSuccessDialog,
  type CreateSuccessInfo,
} from "./components/CreateSuccessDialog";
import { WarningDialog } from "./components/WarningDialog";
import {
  IntroMuxFallbackDialog,
  type IntroMuxFallbackChoice,
} from "./components/IntroMuxFallbackDialog";
import {
  BodyConcatFallbackDialog,
  type BodyConcatFallbackChoice,
} from "./components/BodyConcatFallbackDialog";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastHost } from "./components/ToastHost";
import { SplashScreen } from "./components/SplashScreen";
import { AppChrome } from "./components/chrome/AppChrome";
import { ServerStatusIndicator } from "./components/ServerStatusIndicator";
import { UpdateDialog } from "./components/UpdateDialog";
import { SdModeSelector } from "./components/SdModeSelector";
import { SdDriveSelector } from "./components/SdDriveSelector";
import { SdFileSelector } from "./components/SdFileSelector";
import { HistoryDialog } from "./components/HistoryDialog";
import { LogConsole } from "./components/LogConsole";
import { SettingsCluster } from "./components/SettingsCluster";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { useVideoStore } from "./store/videoStore";
import { usePhotoStore } from "./store/photoStore";
import { useConfigStore } from "./store/configStore";
import { useKundeStore } from "./store/kundeStore";
import { useUiStore, type DialogActionStatus } from "./store/uiStore";
import { useSdStore, isSdPipelineBusy } from "./store/sdStore";
import { useServerStore } from "./store/serverStore";
import { useAppendStore } from "./store/appendStore";
import { usePreviewCacheStore, previewEncodingSignature } from "./store/previewCacheStore";
import { useSdCardMonitor } from "./hooks/useSdCardMonitor";
import { useWorkflowProgress } from "./hooks/useWorkflowProgress";
import { useVideoCutApply } from "./hooks/useVideoCutApply";
import { usePhotoEditApply } from "./hooks/usePhotoEditApply";
import { useLogListener } from "./hooks/useLogListener";
import { useAmsBridgeHealthPoll } from "./hooks/useAmsBridgeHealthPoll";
import { useLogStore } from "./store/logStore";
import {
  checkForUpdates,
  discardVideoCutUndoForPath,
  clearWorkingSession,
  createJob,
  getAppInfo,
  getUpdaterInstallHint,
  cancelUpdateInstall,
  installSpecificVersion,
  installUpdate,
  resolveBodyConcatFallback,
  resolveIntroMuxFallback,
  runStartupChecks,
  uploadToServer,
  validateCreateJob,
  type AvailableRelease,
  type BodyConcatFallbackPayload,
  type CreateJobResult,
  type HwAccelInfo,
  type IntroMuxFallbackPayload,
  type UpdateInstallProgress,
  type UploadProgressEvent,
} from "./lib/tauri";
import { compareVersionParts } from "./lib/versionCompare";
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
import {
  pathsAddedSince,
  runAutoQrAfterImport,
  shouldAutoQrAfterImport,
  type AutoQrScanOutcome,
} from "./lib/autoQrScan";
import { fileBaseName, QR_SUCCESS_TITLE } from "./lib/qrSuccess";
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
import { summarizeCreateHints } from "./lib/createReadyHints";
import { cn, isCancellationError } from "./lib/utils";
import { isImportCancellation, rollbackImportBatch } from "./lib/importRollback";
import "./App.css";

type EncodeProgress = {
  percent: number;
  current_secs: number;
  total_secs: number;
  status: string;
  task_id?: number | null;
};

type TaskProgressState = {
  taskId: number;
  percent: number;
  status: string;
};

function App() {
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
  const previewCacheMatches = usePreviewCacheStore((s) => s.matches);
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
  const createReadyPulsePending = useUiStore((s) => s.createReadyPulsePending);
  const clearCreateReadyPulse = useUiStore((s) => s.clearCreateReadyPulse);
  const createReadyWasFalseRef = useRef(true);

  const checkServerConnection = useServerStore((s) => s.checkConnection);
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
  const sdPhase = useSdStore((s) => s.phase);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const backupProgress = useSdStore((s) => s.backupProgress);
  const workflowProgress = useSdStore((s) => s.workflowProgress);
  const secondaryBackup = useSdStore((s) => s.secondaryBackup);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const qrScanBusy = useQrScanStore((s) => s.busy);
  const qrScanStage = useQrScanStore((s) => s.stage);
  const qrScanByPath = useQrScanStore((s) => s.byPath);
  const qrFollowup = useQrScanStore((s) => s.followup);
  const qrClipProgress = useQrScanStore((s) => s.clipProgress);
  const qrScanOrder = useQrScanStore((s) => s.scanOrder);
  const qrPhotoEdgeLimited = useQrScanStore((s) => s.photoEdgeLimited);

  const [hwInfo, setHwInfo] = useState<HwAccelInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState("");
  const [taskProgress, setTaskProgress] = useState<TaskProgressState[]>([]);
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
  } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateInstallProgress, setUpdateInstallProgress] =
    useState<UpdateInstallProgress | null>(null);
  const [updaterPlatformHint, setUpdaterPlatformHint] = useState<string | null>(
    null,
  );
  const [splashOpen, setSplashOpen] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Wird geladen…");
  const [splashError, setSplashError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [ready, setReady] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [createReady, setCreateReady] = useState(false);
  const [createHints, setCreateHints] = useState<string[]>([]);
  const [createReadyPulse, setCreateReadyPulse] = useState(false);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessInfo | null>(null);
  const [introMuxFallback, setIntroMuxFallback] = useState<{
    reason: string;
    timeoutSecs: number;
  } | null>(null);
  const [bodyConcatFallback, setBodyConcatFallback] = useState<{
    reason: string;
  } | null>(null);
  /** SD workflow (Auto + Confirm after submit): floating progress + UI lock. */
  const [sdWorkflowUiActive, setSdWorkflowUiActive] = useState(false);
  const sdDrainLockRef = useRef(false);
  const sdDrainTimerRef = useRef<number | null>(null);

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
  const appendGuest = useAppendStore((s) => s.context?.guest ?? null);
  const appendWasActiveRef = useRef(false);

  const installBlockedReason = (() => {
    if (updateInstalling) return "Installation läuft bereits…";
    if (busy) return "Während der Verarbeitung nicht möglich.";
    if (appendActive) return "Während Nachreichen nicht möglich.";
    if (sdWorkflowUiActive) return "Während der SD-Aktion nicht möglich.";
    if (qrScanBusy) return "Während der QR-Erkennung nicht möglich.";
    if (serverPhase === "uploading") return "Während dem Upload nicht möglich.";
    return null;
  })();

  async function runUpdateCheck(forceDialog = false) {
    try {
      const result = await checkForUpdates();
      setVersionInstall({
        fromVersion: result.current_version,
        toVersion: result.latest_version,
        notes: result.body,
        available: result.available,
        message: result.message,
        updaterJsonUrl: null,
        silentAvailable: true,
        installerUrl: null,
      });
      if (forceDialog || result.available) {
        setUpdateDialogOpen(true);
      }
    } catch (e) {
      if (forceDialog) showError(String(e), "Update");
    }
  }

  function openVersionSwitchDialog(release: AvailableRelease) {
    if (installBlockedReason) {
      showError(installBlockedReason, "Update");
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
        ? "Für diese Version ist die automatische Installation nicht verfügbar."
        : isDowngrade
          ? `Zu Version ${release.tag_name} wechseln?`
          : `Update auf ${release.tag_name} verfügbar.`,
      updaterJsonUrl: release.updater_json_url,
      silentAvailable: Boolean(release.updater_json_url),
      installerUrl: release.installer_url,
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
      showSuccess(msg, "Update");
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        showWarning("Version installiert — bitte App manuell neu starten.");
      }
    } catch (e) {
      const msg = String(e);
      if (/abgebrochen/i.test(msg)) {
        // Stay on dialog so user can retry or dismiss with Später.
      } else {
        showError(msg, "Update");
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
      setLoading(true, "SD-Dateien werden gelesen…");
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
        showWarning(msg, "SD");
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
        label: "Import",
        tone: "skipped",
        summary: "Keine Dateien.",
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
      `${result.imported_videos.length} Videos, ${result.imported_photos.length} Fotos` +
      (result.skipped ? ` · ${result.skipped} übersprungen` : "");

    const importAction: DialogActionStatus = {
      kind: "import",
      label: "Import",
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

    if (!willAutoScan) {
      return { importAction, qrAction: null, qrHit: null };
    }

    useSdStore.getState().setWorkflowProgress(null);
    // Overlay stays suppressed while sdWorkflowUiActive; message feeds SD progress.
    setLoading(true, "QR-Code suchen…");
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
            label: "QR-Code",
            tone: "warning",
            summary: qr.message || "QR-Scan abgebrochen.",
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
            label: "QR-Code",
            tone: "success",
            summary: "Kundendaten übernommen",
            detail: src ? `Quelle: ${src}` : undefined,
          },
          qrHit: qr,
        };
      }

      return {
        importAction,
        qrAction: {
          kind: "qr",
          label: "QR-Code",
          tone: "warning",
          summary: qr.message || "Kein QR-Code gefunden.",
        },
        qrHit: null,
      };
    } catch (qrErr) {
      return {
        importAction,
        qrAction: {
          kind: "qr",
          label: "QR-Code",
          tone: "error",
          summary: "Scan fehlgeschlagen",
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
          ? "Bereinigen ist nur nach einem Backup möglich."
          : "Keine Aktion ausgewählt.",
      );
      return false;
    }
    if (!doBackup && actions.clear) {
      showWarning("Bereinigen ist nur nach einem Backup möglich.");
      return false;
    }

    if (doBackup && !config?.sd_backup_folder?.trim()) {
      showError("Bitte in den Einstellungen einen Backup-Ordner wählen.");
      return false;
    }

    hooks?.onStart?.();
    useSdStore.getState().setWorkflowActive(true);
    useSdStore.getState().beginWorkflowMount(drive);
    setLoading(true, "SD-Verarbeitung…");
    const statusActions: DialogActionStatus[] = [];
    let qrHit: AutoQrScanOutcome | null = null;
    let ejected = false;

    async function tryEjectSd(opts?: { midWorkflowToast?: boolean }): Promise<void> {
      if (!doEject || ejected) return;
      ejected = true;
      const ejectDetail = resolveSdEjectDetail(drive);
      setLoading(true, "SD-Karte wird ausgeworfen…");
      try {
        await ejectSdCard(drive);
        useSdStore.getState().markWorkflowMountReleased();
        statusActions.push({
          kind: "eject",
          label: "Auswerfen",
          tone: "success",
          summary: "SD-Karte ausgeworfen — kann sicher entfernt werden",
          detail: ejectDetail,
        });
        if (opts?.midWorkflowToast) {
          showSdEjectToast({ drive, detail: ejectDetail, ok: true });
        }
      } catch (e) {
        statusActions.push({
          kind: "eject",
          label: "Auswerfen",
          tone: "error",
          summary: "Auswerfen fehlgeschlagen",
          detail: `${String(e)}\nBitte die Karte manuell sicher entfernen.`,
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
        setLoading(true, "SD-Backup läuft…");
        const res = await backupSdCard(drive, selectedPaths, doClear);
        if (!res.success) {
          if (isCancellationError(res.error_message)) {
            showWarning("SD-Backup abgebrochen.", "Backup");
            return true;
          }
          const failMsg =
            (res.error_message || "Backup fehlgeschlagen") +
            (actions.clear
              ? "\n\nSD wurde nicht bereinigt (kein erfolgreiches Backup)."
              : "");
          if (isEmptyCatalogMessage(res.error_message || "")) {
            showWarning(failMsg, "SD");
          } else {
            showError(failMsg);
          }
          return true;
        }
        const backupDetails = [
          res.backup_path ?? "",
          res.secondary_backup_path
            ? `Zweiter Pfad: ${res.secondary_backup_path}`
            : res.secondary_async_started
              ? "Zweiter Pfad: läuft im Hintergrund…"
              : "",
          res.skipped_count ? `Übersprungen: ${res.skipped_count}` : "",
          res.secondary_warning?.trim() ?? "",
        ]
          .map((s) => s.trim())
          .filter(Boolean);
        const backupWarn = Boolean(res.secondary_warning?.trim());
        statusActions.push({
          kind: "backup",
          label: "Backup",
          tone: backupWarn ? "warning" : "success",
          summary: `${res.copied_count} Dateien kopiert`,
          detail: backupDetails.length ? backupDetails.join("\n") : undefined,
        });
        if (doClear) {
          const clearWarn = Boolean(res.clear_warning?.trim());
          const deleted = res.clear_deleted_count ?? 0;
          if (clearWarn || deleted <= 0) {
            statusActions.push({
              kind: "clear",
              label: "Bereinigen",
              tone: "warning",
              summary: clearWarn
                ? "Bereinigung fehlgeschlagen"
                : "Nicht bereinigt",
              detail: res.clear_warning?.trim() || undefined,
            });
          } else {
            statusActions.push({
              kind: "clear",
              label: "Bereinigen",
              tone: "success",
              summary: `${deleted} Datei(en) bereinigt`,
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
            label: "Import",
            tone: "skipped",
            summary: "Keine Dateien.",
          });
        } else {
          setPhase("importing");
          useSdStore.getState().setBackupProgress(null);
          useSdStore.getState().setWorkflowProgress(null);
          setLoading(true, "Importiere SD-Dateien…");
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
        };
        statusActions.sort((a, b) => order[a.kind] - order[b.kind]);

        const hasError = statusActions.some((a) => a.tone === "error");
        const title = hasError
          ? "Teilweise erfolgreich"
          : qrHit?.applied
            ? (qrHit.successTitle ?? QR_SUCCESS_TITLE)
            : qrHit?.keptExisting
              ? "Erfolg"
              : qrHit
                ? (qrHit.successTitle ?? QR_SUCCESS_TITLE)
                : "Erfolg";

        const queuedNext = useSdStore.getState().jobQueue.length > 0;
        showSuccess("", title, {
          ...(qrHit?.applied || qrHit?.keptExisting
            ? (qrHit.successOptions ?? {
                variant: "qr" as const,
                highlight: qrHit.kundeName || "Kunde erkannt",
              })
            : {}),
          // Free the pipeline sooner when another SD is waiting.
          autoCloseSecs: queuedNext ? 2 : 10,
          actions: statusActions,
        });
      }
      return true;
    } catch (e) {
      if (isCancellationError(e)) {
        showWarning("SD-Workflow abgebrochen.", "SD");
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
    setLoading(true, "SD-Dateien werden gelesen…");
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
        showWarning(msg, "SD");
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
        setSplashStatus("Lade App-Info…");
        const info = await getAppInfo();
        if (!cancelled) setAppVersion(info.version);
        void getUpdaterInstallHint()
          .then((hint) => {
            if (!cancelled) setUpdaterPlatformHint(hint);
          })
          .catch(() => undefined);

        setSplashStatus("Lade Einstellungen…");
        await loadConfig();

        setSplashStatus("Prüfe FFmpeg & Hardware…");
        const checks = await runStartupChecks(true);
        if (cancelled) return;

        if (checks.hw) setHwInfo(checks.hw);
        setAppVersion(checks.version);
        setSplashStatus(checks.message);

        if (!checks.ok) {
          setSplashError(checks.ffmpeg_error || checks.message);
          showError(
            checks.ffmpeg_error ||
              "FFmpeg wurde nicht gefunden. Encoding ist nicht verfügbar.",
            "FFmpeg",
          );
        } else if (checks.media_warning) {
          showWarning(checks.media_warning, "Video-Wiedergabe");
        }

        setSplashStatus("Bereit!");
        await new Promise((r) => setTimeout(r, 350));
        if (!cancelled) {
          setReady(true);
          setSplashOpen(false);
        }

        void runUpdateCheck(false);
      } catch (e) {
        if (cancelled) return;
        const msg = String(e);
        setSplashError(msg);
        setSplashStatus("Start mit Fehlern");
        showError(msg, "Start");
        setReady(true);
        setSplashOpen(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadConfig, showError, showWarning]);

  useEffect(() => {
    if (!ready || !config || splashOpen) return;
    if (!config.setup_completed) setSetupWizardOpen(true);
  }, [ready, config, splashOpen]);

  useEffect(() => {
    if (!config?.server_url || !ready || setupWizardOpen) return;
    void checkServerConnection();
  }, [
    config?.server_url,
    config?.server_login,
    config?.server_password,
    checkServerConnection,
    ready,
    setupWizardOpen,
  ]);

  useAmsBridgeHealthPoll(ready && !splashOpen && !setupWizardOpen);

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
            prev !== "In Arbeit…"
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
      setStatus("Stream-Copy fehlgeschlagen — bitte Entscheidung…");
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
      setStatus("Fast Path fehlgeschlagen — bitte Entscheidung…");
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
        ? "Exportiere Video ohne Intro…"
        : "Kodiere Intro+Video neu…",
    );
    try {
      await resolveIntroMuxFallback(choice);
    } catch (e) {
      showError(String(e), "Intro-Entscheidung");
    }
  }

  async function onBodyConcatChoice(choice: BodyConcatFallbackChoice) {
    setBodyConcatFallback(null);
    setStatus(
      choice === "use_legacy"
        ? "Legacy-Zusammenfügen…"
        : "Vorgang abgebrochen…",
    );
    try {
      await resolveBodyConcatFallback(choice);
    } catch (e) {
      showError(String(e), "Clip-Zusammenfügen");
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UploadProgressEvent>("upload-progress", (event) => {
      const p = event.payload;
      setUploadProgress(p);
      setPercent(p.percent);
      const parts = [`Upload ${p.percent.toFixed(0)}%`];
      if (p.total_files > 0 && p.current_file > 0) {
        parts.push(`Datei ${p.current_file}/${p.total_files}`);
      }
      if (p.filename) parts.push(p.filename);
      setStatus(parts.join(" · "));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [setUploadProgress]);

  function resetProgress() {
    setPercent(0);
    setStatus("");
    setTaskProgress([]);
  }

  useEffect(() => {
    if (appendActive && !appendWasActiveRef.current) {
      resetProgress();
      setStatus("Starte Nachreichung…");
      setPercent(1);
    }
    appendWasActiveRef.current = appendActive;
  }, [appendActive]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        const paths = videoList.map((v) => v.path);
        const photos = photoList.map((p) => p.path);
        const wmPhotos = [...watermarkPhotoIndices].sort((a, b) => a - b);
        try {
          const validation = await validateCreateJob(
            kunde,
            paths,
            photos,
            wmPhotos,
            config?.oldschool_mode,
          );
          if (cancelled) return;
          const hints = [...validation.errors];
          if (!config?.speicherort?.trim()) {
            hints.push("Speicherort wird beim Erstellen abgefragt und gespeichert.");
          }
          setCreateHints(hints);
          setCreateReady(validation.valid);
        } catch {
          if (!cancelled) {
            setCreateReady(false);
            setCreateHints(["Validierung fehlgeschlagen"]);
          }
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    ready,
    kunde,
    videoList,
    photoList,
    watermarkPhotoIndices,
    config?.oldschool_mode,
    config?.manual_entry_mode,
    config?.speicherort,
  ]);

  async function ensureSpeicherort(forcePick = false): Promise<string | null> {
    const current = config?.speicherort?.trim() ?? "";
    if (current && !forcePick) return current;

    const selected = await open({
      directory: true,
      multiple: false,
      title: "Speicherort für fertige Vorgänge wählen",
      defaultPath: current || undefined,
    });
    if (typeof selected !== "string" || !selected) {
      if (!forcePick) showWarning("Kein Speicherort gewählt.", "Speicherort");
      return forcePick ? current || null : null;
    }
    if (!config) {
      showError("Einstellungen noch nicht geladen.");
      return null;
    }
    const saved = await persistConfig({ ...config, speicherort: selected });
    if (!saved) {
      showError("Speicherort konnte nicht gespeichert werden.");
      return null;
    }
    showSuccess(`Speicherort gespeichert:\n${selected}`, "Speicherort");
    return selected;
  }

  async function openSpeicherortFolder() {
    const path = config?.speicherort?.trim() ?? "";
    if (!path) {
      showError("Kein Speicherort gesetzt.");
      return;
    }
    try {
      await revealItemInDir(path);
    } catch (e) {
      showError(String(e), "Speicherort");
    }
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
      showWarning(validation.errors.join("\n"), "Validierung");
      return;
    }

    if (config?.upload_to_server && !serverConnected) {
      showWarning(
        "Upload ist aktiv, aber der Server ist nicht erreichbar.\nBitte Einstellungen prüfen oder Upload deaktivieren.",
        "Server",
      );
      return;
    }

    setBusy(true);
    resetProgress();
    setStatus("Vorgang wird erstellt…");
    setPercent(1);
    try {
      const codec = (config?.video_codec ?? "auto") as "auto" | "h264" | "h265";
      const encodingSig = previewEncodingSignature(
        Boolean(config?.intro_enabled ?? false),
        config?.dauer ?? 5,
        config?.intro_mux_mode ?? "reencode",
      );
      const canReusePreview = previewCacheMatches(videoList, kunde, encodingSig);
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
        },
        kunde.form_mode === "kunde" ? qrPreview : null,
      );

      let uploadNote: string | null = null;
      let serverUploaded = false;
      if (config?.upload_to_server) {
        setStatus("Upload zum Server…");
        setTaskProgress([]);
        setServerPhase("uploading");
        setUploadProgress(null);
        try {
          const uploaded = await uploadToServer(res.base_output_dir);
          uploadNote = uploaded.remote_path || uploaded.message || null;
          serverUploaded = true;
          setServerPhase("connected");
        } catch (uploadErr) {
          setServerPhase("error");
          showError(String(uploadErr), "Upload");
          uploadNote = "Upload fehlgeschlagen (siehe Fehlerdialog).";
        } finally {
          setUploadProgress(null);
        }
      }

      setCreateSuccess({
        result: res,
        serverUploaded,
        uploadNote,
        vorname: kunde.vorname,
        nachname: kunde.nachname,
      });
      setPercent(100);
      setStatus("Vorgang fertig");
      setTaskProgress([]);

      if (config?.auto_clear_files_after_creation) {
        videoCuts.clearUndoState();
        clearVideos();
        clearPhotos();
        clearPreviewCache();
        void clearWorkingSession();
        resetSession({
          tandemmaster: config.keep_tandemmaster_on_session_reset,
          videospringer: config.keep_videospringer_on_session_reset,
          tandemmasterFixed: config.tandemmaster,
          videospringerFixed: config.videospringer,
        });
        clearCreateReadyPulse();
        setCreateReadyPulse(false);
      }
    } catch (e) {
      if (isCancellationError(e)) {
        setStatus("Abgebrochen");
        showWarning("Vorgang abgebrochen.");
      } else {
        showError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const cancellingQr = qrScanBusy && !busy && !appendActive;
    try {
      await invoke("cancel_encode");
      if (!cancellingQr && busy) {
        setStatus("cancelled");
        showWarning("Vorgang abgebrochen.");
      } else if (!cancellingQr && appendActive) {
        setStatus("cancelled");
        showWarning("Nachreichen abgebrochen.");
      }
      // SD backup/import and QR: dedicated message when the job returns.
    } catch (e) {
      if (!isCancellationError(e)) showError(String(e));
    }
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

  function handleSessionReset() {
    if (busy || appendActive || loading || sdWorkflowUiActive || qrScanBusy) {
      showWarning(
        "Zurücksetzen ist während einer laufenden Verarbeitung nicht möglich.",
        "Zurücksetzen",
      );
      return;
    }
    const ok = window.confirm(
      "Alles zurücksetzen?\n\nFormular sowie alle importierten Videos und Fotos werden verworfen.\nTandemmaster/Videospringer werden je nach Einstellung beibehalten.",
    );
    if (!ok) return;
    clearSdQueue();
    videoCuts.clearUndoState();
    clearVideos();
    clearPhotos();
    clearPreviewCache();
    void clearWorkingSession();
    resetSession({
      tandemmaster: config?.keep_tandemmaster_on_session_reset,
      videospringer: config?.keep_videospringer_on_session_reset,
      tandemmasterFixed: config?.tandemmaster,
      videospringerFixed: config?.videospringer,
    });
    clearCreateReadyPulse();
    setCreateReadyPulse(false);
    showSuccess("Session zurückgesetzt.", "Zurücksetzen", {
      autoCloseSecs: 5,
    });
  }

  const hwLabel = hwInfo
    ? `${hwInfo.encoder}${hwInfo.available ? "" : " (Software)"}`
    : null;

  const uploadActive = Boolean(config?.upload_to_server && serverConnected);
  const uploadBlocked = Boolean(config?.upload_to_server) && !serverConnected;
  const uploadNudge = serverConnected && !config?.upload_to_server;
  const autoClearAfterCreate = Boolean(config?.auto_clear_files_after_creation);
  const uploadTitle = !serverConnected
    ? uploadBlocked
      ? "Upload in den Einstellungen aktiv, Server nicht verbunden"
      : "Server nicht verbunden — Upload nicht möglich"
    : uploadActive
      ? "Aktiv — Vorgang wird nach Erstellen hochgeladen"
      : "Upload aus — einschalten, wenn der Vorgang auf den Server soll";

  const uiLocked =
    busy ||
    appendActive ||
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  /** SD / Import / Copy / QR pipeline — media & actions stay locked. */
  const pipelineActive =
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  /**
   * Manual mode: Kundensektion bleibt während Pipeline editierbar.
   * QR mode: Formular gesperrt (Crew weiter separat über crewDisabled).
   * Encode/Vorgang (`busy`): immer gesperrt.
   */
  const customerFormLocked =
    busy || (kunde.form_mode === "kunde" && pipelineActive);

  /** Ort/Datum wie Crew: parallel zur Pipeline nutzbar, nur bei Encode/Vorgang zu. */
  const sessionStripLocked = busy;

  /** Kein QR↔Manuell-Wechsel mitten in Backup/Import/Scan. */
  const formModeToggleLocked = busy || pipelineActive;

  const createBanner = summarizeCreateHints(createHints);

  // After QR crew dropdown workflow: pulse Erstellen only when it newly unlocks.
  useEffect(() => {
    const becameReady = createReadyWasFalseRef.current && createReady;
    createReadyWasFalseRef.current = !createReady;

    if (!createReadyPulsePending) return;

    if (!createReady) return;

    // Already unlocked before this crew step — no pulse.
    if (!becameReady) {
      clearCreateReadyPulse();
      return;
    }

    if (uiLocked) return;

    clearCreateReadyPulse();
    setCreateReadyPulse(true);
    const t = window.setTimeout(() => setCreateReadyPulse(false), 2150);
    return () => window.clearTimeout(t);
  }, [
    createReadyPulsePending,
    createReady,
    uiLocked,
    clearCreateReadyPulse,
  ]);

  // Drop stale pulse requests if create stays blocked (e.g. missing media).
  useEffect(() => {
    if (!createReadyPulsePending || createReady) return;
    const t = window.setTimeout(() => clearCreateReadyPulse(), 900);
    return () => window.clearTimeout(t);
  }, [createReadyPulsePending, createReady, clearCreateReadyPulse]);

  const appendUploading = appendActive && /^upload/i.test(status.trim());

  const workflowView = useWorkflowProgress({
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
    appendUploading,
    percent,
    status,
    taskProgress,
  });

  useEffect(() => {
    if (busy || appendActive) return;
    if (percent <= 0 && taskProgress.length === 0 && !status.trim()) return;
    if (workflowView.visible) return;
    resetProgress();
  }, [busy, appendActive, percent, taskProgress.length, status, workflowView.visible]);

  return (
    <div className="flex h-full min-h-screen flex-col text-foreground">
      <SplashScreen
        open={splashOpen}
        status={splashStatus}
        version={appVersion}
        error={splashError}
      />

      <AppChrome
        actions={
          <>
            <SdDriveSelector
              disabled={uiLocked || !ready}
              onOpenDrive={(drive) => void openSdDriveFromHeader(drive)}
              onPrimaryAction={(drive) => void handleSdPrimaryAction(drive)}
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
              onClick={() => setProcessedOpen(true)}
              disabled={busy || !ready}
              title="Verarbeitete Dateien"
            >
              <FolderClock className="h-4 w-4" />
              <span className="hidden sm:inline">Historie</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleSessionReset}
              disabled={uiLocked || !ready}
              title="Formular und Medien zurücksetzen"
              className="border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Zurücksetzen</span>
            </Button>
            <SettingsCluster
              disabled={!ready}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </>
        }
      >
        <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
          {/* h-[34px] = MAC_LOGO_TILE_PX — macOS traffic-light center in macTrafficLights.ts */}
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
                ? `Server-Backup ${Math.round(secondaryBackup.percent)}%` +
                  (secondaryBackup.file_name
                    ? ` · ${secondaryBackup.file_name}`
                    : "")
                : secondaryBackup?.state === "done"
                  ? "Server-Backup fertig"
                  : hwLabel
                    ? `Encoder: ${hwLabel}`
                    : ready
                      ? "Bereit"
                      : "Start…"}
            </p>
          </div>
        </div>
      </AppChrome>

      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="ats-sidebar-bg flex w-full max-w-md flex-col border-r border-border backdrop-blur-md sm:w-[400px]">
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="border-b border-border/40 px-3 pt-1.5 pb-1.5">
              <CustomerSessionStrip disabled={sessionStripLocked} />
            </div>
            <div className="p-4">
              <CustomerForm
                disabled={customerFormLocked}
                crewDisabled={busy}
                modeToggleDisabled={formModeToggleLocked}
              />
            </div>
          </div>

          <div className="space-y-2.5 border-t border-border bg-gradient-to-t from-card/90 to-card/40 p-3.5 backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                Vorgang
              </p>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                <label
                  htmlFor="vorgang-upload"
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                    uploadActive
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : uploadNudge
                        ? "border-destructive bg-destructive/20 text-destructive"
                        : uploadBlocked
                          ? "border-warning/40 bg-warning/10 text-warning"
                          : "border-border bg-card-elevated/80 text-muted",
                    (!serverConnected || uiLocked || !config) && "cursor-not-allowed",
                  )}
                  title={uploadTitle}
                >
                  <CloudUpload className="h-3.5 w-3.5" aria-hidden />
                  Upload
                  <Switch
                    id="vorgang-upload"
                    className="h-4 w-7 [&_span]:h-3 [&_span]:w-3 [&_span]:data-[state=checked]:translate-x-3"
                    checked={uploadActive}
                    disabled={uiLocked || !config || !serverConnected}
                    onCheckedChange={(v) => {
                      if (!config || !serverConnected) return;
                      void persistConfig({
                        ...config,
                        upload_to_server: v === true,
                      });
                    }}
                    aria-label="Server-Upload"
                  />
                </label>
                <label
                  htmlFor="vorgang-clear"
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                    autoClearAfterCreate
                      ? "border-primary/30 bg-primary/5 text-foreground/80"
                      : "border-border bg-card-elevated/80 text-muted",
                    (uiLocked || !config) && "cursor-not-allowed",
                  )}
                  title="Nach Erstellen Formular und Medien zurücksetzen"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Leeren
                  <Switch
                    id="vorgang-clear"
                    className="h-4 w-7 [&_span]:h-3 [&_span]:w-3 [&_span]:data-[state=checked]:translate-x-3"
                    checked={autoClearAfterCreate}
                    disabled={uiLocked || !config}
                    onCheckedChange={(v) => {
                      if (!config) return;
                      void persistConfig({
                        ...config,
                        auto_clear_files_after_creation: v === true,
                      });
                    }}
                    aria-label="Nach Erstellen Formular und Medien zurücksetzen"
                  />
                </label>
              </div>
            </div>
            {createBanner ? (
              <div
                className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-warning"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-medium leading-snug">
                      {createBanner.headline}
                    </p>
                    <p className="text-[11px] leading-snug text-warning/90">
                      {createBanner.labels.join(" · ")}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="shrink-0"
                onClick={() => void ensureSpeicherort(true)}
                disabled={uiLocked}
                title="Speicherort ändern"
                aria-label="Speicherort ändern"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="shrink-0"
                onClick={() => void openSpeicherortFolder()}
                disabled={uiLocked || !config?.speicherort?.trim()}
                title="Ordner im Explorer öffnen"
                aria-label="Ordner im Explorer öffnen"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </Button>
            <div className="relative flex-1 overflow-visible">
              {createReadyPulse ? (
                <span
                  aria-hidden
                  className="ats-create-ready-halo pointer-events-none absolute inset-0 rounded-md"
                />
              ) : null}
              <Button
                type="button"
                className={cn(
                  "relative z-[1] w-full gap-1.5",
                  createReadyPulse && "ats-create-ready-flash",
                )}
                onClick={() => {
                  void startCreate();
                }}
                disabled={uiLocked || !createReady}
                onAnimationEnd={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    e.animationName === "ats-create-ready-lift"
                  ) {
                    setCreateReadyPulse(false);
                  }
                }}
                title={
                  config?.upload_to_server && serverConnected
                    ? "Vorgang erstellen und auf den Server hochladen"
                    : undefined
                }
              >
                {config?.upload_to_server && serverConnected ? (
                  <>
                    <CloudUpload className="h-4 w-4" aria-hidden />
                    Erstellen & Upload
                  </>
                ) : (
                  "Erstellen"
                )}
              </Button>
            </div>
            </div>
          </div>
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
              workflowView.reserveSpace && "pb-36",
            )}
          >
          <MediaDropZone
            disabled={uiLocked}
            onRemoveVideo={(path) => {
              useVideoStore.getState().clearCutMarksFor([path]);
              void discardVideoCutUndoForPath(path);
            }}
            onSessionCleared={() => {
              videoCuts.clearUndoState();
            }}
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
                  aria-label="Medienart"
                >
                  <TabsTrigger
                    value="video"
                    className="h-full flex-1 gap-2 px-4 data-[state=active]:text-primary"
                  >
                    <Film className="h-4 w-4 shrink-0" aria-hidden />
                    <span>Video</span>
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
                    <span>Foto</span>
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
                      !(uiLocked || (mediaTab === "video" ? videoList.length === 0 : photoList.length === 0)) &&
                        "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                    )}
                    disabled={uiLocked || (mediaTab === "video" ? videoList.length === 0 : photoList.length === 0)}
                    onClick={() => {
                      if (mediaTab === "video") {
                        useVideoStore.getState().clearVideos();
                        videoCuts.clearUndoState();
                      } else {
                        usePhotoStore.getState().clearPhotos();
                      }
                    }}
                  >
                    {mediaTab === "video" ? "Videos leeren" : "Fotos leeren"}
                  </Button>
                </div>
              </div>
              <TabsContent value="video" className="mt-0 space-y-4 p-4">
                <VideoPreview
                  busy={busy || sdWorkflowUiActive}
                  onBusyChange={setBusy}
                  onStatus={setStatus}
                  percent={percent}
                  status={status}
                  taskProgress={taskProgress}
                  onProgressReset={resetProgress}
                  onProgressComplete={(finalStatus) => {
                    setPercent(100);
                    setStatus(finalStatus);
                  }}
                  formReady={createReady}
                  formHints={createHints}
                  playbackSuspended={cutterOpen || busy}
                  canUndoCuts={videoCuts.canUndo}
                  onUndoAllCuts={() => {
                    void videoCuts.undoAll({
                      onBusyChange: setBusy,
                      onProgressReset: resetProgress,
                      onStatus: setStatus,
                    });
                  }}
                  onUndoClipCut={(path) => {
                    void videoCuts.undoForPath(path, {
                      onBusyChange: setBusy,
                      onProgressReset: resetProgress,
                      onStatus: setStatus,
                    });
                  }}
                  onCutClip={(path) => {
                    const meta = videoList.find((v) => v.path === path);
                    setCutterPath(path);
                    setCutterDuration(meta?.duration_secs ?? 0);
                    setCutterOpen(true);
                  }}
                  onBeforeRemoveClip={(path) => {
                    useVideoStore.getState().clearCutMarksFor([path]);
                    void discardVideoCutUndoForPath(path);
                  }}
                />
                <MediaListPanel
                  kind="video"
                  disabled={uiLocked}
                  onRemoveVideo={(path) => {
                    useVideoStore.getState().clearCutMarksFor([path]);
                    void discardVideoCutUndoForPath(path);
                  }}
                  onCutVideo={(path) => {
                    const meta = videoList.find((v) => v.path === path);
                    setCutterPath(path);
                    setCutterDuration(meta?.duration_secs ?? 0);
                    setCutterOpen(true);
                    setMediaTab("video");
                  }}
                  onUndoVideoCut={(path) => {
                    void videoCuts.undoForPath(path, {
                      onBusyChange: setBusy,
                      onProgressReset: resetProgress,
                      onStatus: setStatus,
                    });
                  }}
                />
              </TabsContent>
              <TabsContent value="foto" className="mt-0 space-y-4 p-4">
                <PhotoPreview
                  disabled={uiLocked}
                  onEditPhoto={(path) => {
                    setPhotoEditorPath(path);
                    setPhotoEditorOpen(true);
                  }}
                  onUndoPhotoEdit={(path) => {
                    void photoEdits.undoForPath(path, {
                      onBusyChange: setBusy,
                      onProgressReset: resetProgress,
                      onStatus: setStatus,
                    });
                  }}
                  onBatchRotate={(paths, degrees) => {
                    void photoEdits.applyRotateMany(paths, degrees, {
                      onBusyChange: setBusy,
                      onProgressReset: resetProgress,
                      onStatus: setStatus,
                    });
                  }}
                />
                <MediaListPanel kind="foto" disabled={uiLocked} />
              </TabsContent>
            </Tabs>
          </section>
          </div>

          <div
            className="pointer-events-none absolute inset-x-4 bottom-4 z-20"
          >
            <WorkflowProgressPanel
              view={workflowView}
              onCancel={() => void cancel()}
              className="mx-auto max-w-2xl"
            />
          </div>
        </main>
      </div>
      <LogConsole />
      </div>

      {config ? (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open && (updateDialogOpen || updateInstalling)) return;
            setSettingsOpen(open);
          }}
          onRequestUpdateCheck={() => void runUpdateCheck(true)}
          onRequestVersionSwitch={openVersionSwitchDialog}
          installBlockedReason={installBlockedReason}
          platformHint={updaterPlatformHint}
          onAfterFactoryReset={() => {
            setSettingsOpen(false);
            setSetupWizardOpen(true);
          }}
          suppressDismiss={updateDialogOpen || updateInstalling}
        />
      ) : null}
      <SetupWizard
        open={setupWizardOpen}
        onComplete={() => {
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
      />
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
        onInstall={() => void runInstallVersion()}
        onCancelInstall={() => void cancelInstallVersion()}
        onLater={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
        onClose={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
      />
      <SdFileSelector
        defaultActions={settingsSdActions()}
        onClose={() => {
          sdEnrichGenRef.current += 1;
          closeSelector();
          scheduleSdQueueDrain();
        }}
        onConfirm={(paths, actions) => void handleSelectorConfirm(paths, actions)}
        onProceedAll={(actions) => void handleSelectorProceedAll(actions)}
        onRefresh={() => {
          const drive = useSdStore.getState().selectorDrive;
          const mode = useSdStore.getState().selectorMode;
          if (!drive) return;
          void openSdSelector(
            drive,
            mode === "size_limit" ? "size_limit" : "backup",
          );
        }}
      />
      <HistoryDialog open={processedOpen} onOpenChange={setProcessedOpen} />
      <VideoCutter
        open={cutterOpen}
        videoPath={cutterPath}
        durationSecsHint={cutterDuration}
        onClose={() => {
          setCutterOpen(false);
          setCutterPath(null);
        }}
        onComplete={(result: VideoCutterResult) => {
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
      />
      <PhotoEditor
        open={photoEditorOpen}
        photoPath={photoEditorPath}
        onClose={() => {
          setPhotoEditorOpen(false);
          setPhotoEditorPath(null);
        }}
        onComplete={(result: PhotoEditorResult) => {
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
      />
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
        onClose={() => {
          closeDialog();
          scheduleSdQueueDrain();
        }}
      />
      <CreateSuccessDialog
        open={createSuccess !== null}
        info={createSuccess}
        onClose={() => setCreateSuccess(null)}
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
    </div>
  );
}

export default App;
