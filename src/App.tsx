import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CloudUpload,
  Film,
  FolderOpen,
  History,
  ImageIcon,
  RotateCcw,
  Settings,
} from "lucide-react";
import { ProgressIndicator } from "./components/ProgressIndicator";
import { MediaDropZone } from "./components/MediaDropZone";
import { MediaListPanel } from "./components/MediaListPanel";
import { VideoPreview } from "./components/VideoPreview";
import { PhotoPreview } from "./components/PhotoPreview";
import { VideoCutter, type VideoCutterResult } from "./components/VideoCutter";
import { CustomerForm, CustomerSessionStrip } from "./components/CustomerForm";
import { SettingsDialog } from "./components/SettingsDialog";
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
import { LoadingOverlay } from "./components/LoadingOverlay";
import { SplashScreen } from "./components/SplashScreen";
import { ServerStatusIndicator } from "./components/ServerStatusIndicator";
import { UpdateDialog } from "./components/UpdateDialog";
import { SdModeSelector } from "./components/SdModeSelector";
import { SdDriveSelector } from "./components/SdDriveSelector";
import { SdFileSelector, type SdSelectorProgress } from "./components/SdFileSelector";
import { HistoryDialog } from "./components/HistoryDialog";
import { ThemeToggle } from "./components/ThemeToggle";
import { LogConsole, LogConsoleToggleButton } from "./components/LogConsole";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Switch } from "./components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { useVideoStore } from "./store/videoStore";
import { usePhotoStore } from "./store/photoStore";
import { useConfigStore } from "./store/configStore";
import { useKundeStore } from "./store/kundeStore";
import { useUiStore, type DialogActionStatus } from "./store/uiStore";
import { useSdStore } from "./store/sdStore";
import { useServerStore } from "./store/serverStore";
import { usePreviewCacheStore, previewEncodingSignature } from "./store/previewCacheStore";
import { useSdCardMonitor } from "./hooks/useSdCardMonitor";
import { useVideoCutApply } from "./hooks/useVideoCutApply";
import { useLogListener } from "./hooks/useLogListener";
import { useLogStore } from "./store/logStore";
import {
  checkForUpdates,
  discardVideoCutUndoForPath,
  clearWorkingSession,
  createJob,
  getAppInfo,
  installUpdate,
  resolveIntroMuxFallback,
  runStartupChecks,
  uploadToServer,
  validateCreateJob,
  type CreateJobResult,
  type HwAccelInfo,
  type IntroMuxFallbackPayload,
  type UpdateCheckResult,
  type UpdateInstallProgress,
  type UploadProgressEvent,
} from "./lib/tauri";
import {
  backupSdCard,
  ejectSdCard,
  enrichSdFiles,
  importSdFiles,
  listSdFiles,
  type BackupProgress,
  type SdWorkflowActions,
  type WorkflowProgress,
} from "./lib/sdCard";
import {
  pathsAddedSince,
  runAutoQrAfterImport,
  shouldAutoQrAfterImport,
  type AutoQrScanOutcome,
} from "./lib/autoQrScan";
import { fileBaseName, QR_SUCCESS_TITLE } from "./lib/qrSuccess";
import {
  summarizeQrScanProgress,
  useQrScanStore,
  withQrScanProgress,
} from "./store/qrScanStore";
import { useQrScanProgressListener } from "./hooks/useQrScanProgress";
import {
  applyMonotonicPercent,
  formatOverallProgressLabel,
  resolveProgressLabel,
  shouldClearTaskProgress,
  taskProgressLabel,
} from "./lib/progressLabels";
import { cn, isCancellationError } from "./lib/utils";
import "./App.css";

function formatWorkflowDetail(p: WorkflowProgress): string | undefined {
  const parts: string[] = [];
  if (
    p.total_mb != null &&
    p.total_mb > 0 &&
    p.current_mb != null
  ) {
    parts.push(`${p.current_mb.toFixed(0)}/${p.total_mb.toFixed(0)} MB`);
  }
  if (p.speed_mbps != null && p.speed_mbps > 0) {
    parts.push(`${p.speed_mbps.toFixed(1)} MB/s`);
  }
  // Clear / simple step progress (no per-file index on the label).
  if (
    (p.file_index == null || p.file_index <= 0) &&
    p.total > 0 &&
    (p.current_mb == null || p.total_mb == null)
  ) {
    parts.push(`${p.current}/${p.total}`);
  }
  const name = p.file_name?.trim();
  if (name) {
    parts.push(name);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatWorkflowLabel(p: WorkflowProgress, fallback: string): string {
  const base = (p.label || fallback).trim() || fallback;
  if (p.file_total != null && p.file_total > 0 && p.file_index != null && p.file_index > 0) {
    return `${base} (${p.file_index}/${p.file_total})`;
  }
  return base;
}

function resolveSdSelectorProgress(opts: {
  submitting: boolean;
  phase: string;
  backupProgress: BackupProgress | null;
  workflowProgress: WorkflowProgress | null;
  loadingMessage: string;
  qrBusy: boolean;
  qrStage: import("./store/qrScanStore").QrScanJobStage;
  qrByPath: Record<string, import("./store/qrScanStore").QrScanPhase>;
  qrFollowup: import("./store/qrScanStore").QrFollowupStatus | null;
}): SdSelectorProgress | null {
  if (!opts.submitting) return null;

  const { phase, backupProgress, workflowProgress, loadingMessage } = opts;
  const msg = loadingMessage.trim();

  if (workflowProgress && (workflowProgress.stage === "clear" || workflowProgress.stage === "import")) {
    const fallback =
      workflowProgress.stage === "clear"
        ? "SD wird bereinigt…"
        : msg || "Importiere…";
    return {
      percent: workflowProgress.percent,
      label: formatWorkflowLabel(workflowProgress, fallback),
      detail: formatWorkflowDetail(workflowProgress),
    };
  }

  if (backupProgress) {
    const isClearing = phase === "clearing";
    const detailParts = [
      `${backupProgress.current_mb.toFixed(0)}/${backupProgress.total_mb.toFixed(0)} MB`,
    ];
    if (backupProgress.speed_mbps > 0 && !isClearing) {
      detailParts.push(`${backupProgress.speed_mbps.toFixed(1)} MB/s`);
    }
    const fileName = backupProgress.file_name?.trim();
    if (fileName && !isClearing) {
      detailParts.push(fileName);
    }
    let label = isClearing
      ? "SD wird bereinigt…"
      : msg || "SD-Backup läuft…";
    if (
      !isClearing &&
      backupProgress.file_total != null &&
      backupProgress.file_total > 0 &&
      backupProgress.file_index != null &&
      backupProgress.file_index > 0
    ) {
      label = `${label} (${backupProgress.file_index}/${backupProgress.file_total})`;
    }
    return {
      percent: backupProgress.percent,
      label,
      detail: detailParts.join(" · "),
    };
  }

  if (phase === "clearing") {
    return {
      percent: 100,
      label: "SD wird bereinigt…",
      indeterminate: true,
    };
  }

  // Prefer QR status over generic "importing" once import workflow progress is cleared.
  const qrActive =
    opts.qrBusy || opts.qrStage !== "idle" || /qr/i.test(msg);
  if (qrActive) {
    const summary = summarizeQrScanProgress(
      opts.qrByPath,
      opts.qrStage,
      opts.qrFollowup,
    );
    return {
      percent: summary.percent,
      label: msg && !/^QR-Scan…?$/i.test(msg) && opts.qrStage !== "followup"
        ? msg
        : summary.label,
      detail: summary.detail || undefined,
      indeterminate: summary.indeterminate,
    };
  }

  if (phase === "importing" || /import/i.test(msg)) {
    return {
      percent: 0,
      label: msg || "Importiere SD-Dateien…",
      indeterminate: true,
    };
  }

  return {
    percent: 0,
    label: msg || "SD-Verarbeitung…",
    indeterminate: true,
  };
}

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

  const checkServerConnection = useServerStore((s) => s.checkConnection);
  const setServerPhase = useServerStore((s) => s.setPhase);
  const setUploadProgress = useServerStore((s) => s.setUploadProgress);
  const serverConnected = useServerStore((s) => s.connected);

  const selectorOpen = useSdStore((s) => s.selectorOpen);
  const selectorDrive = useSdStore((s) => s.selectorDrive);
  const selectorFiles = useSdStore((s) => s.selectorFiles);
  const selectorTotalMb = useSdStore((s) => s.selectorTotalMb);
  const selectorMode = useSdStore((s) => s.selectorMode);
  const closeSelector = useSdStore((s) => s.closeSelector);
  const openSelector = useSdStore((s) => s.openSelector);
  const patchSelectorFiles = useSdStore((s) => s.patchSelectorFiles);
  const processedOpen = useSdStore((s) => s.processedOpen);
  const setProcessedOpen = useSdStore((s) => s.setProcessedOpen);
  const setPhase = useSdStore((s) => s.setPhase);
  const sdPhase = useSdStore((s) => s.phase);
  useSdStore((s) => s.activeDrive);
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
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateInstallProgress, setUpdateInstallProgress] =
    useState<UpdateInstallProgress | null>(null);
  const [splashOpen, setSplashOpen] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Wird geladen…");
  const [splashError, setSplashError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [ready, setReady] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [createReady, setCreateReady] = useState(false);
  const [createHints, setCreateHints] = useState<string[]>([]);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessInfo | null>(null);
  const [introMuxFallback, setIntroMuxFallback] = useState<{
    reason: string;
    timeoutSecs: number;
  } | null>(null);
  /** Locks SdFileSelector while confirm workflow runs (incl. QR scan with loading off). */
  const [selectorSubmitting, setSelectorSubmitting] = useState(false);
  /** Auto SD workflow: sticky progress panel (overlay only during prepare). */
  const [autoPanelActive, setAutoPanelActive] = useState(false);

  const videoCuts = useVideoCutApply();
  useQrScanProgressListener();
  useLogListener();
  const consoleOpen = useLogStore((s) => s.open);
  const toggleConsole = useLogStore((s) => s.toggleOpen);
  const setConsoleOpen = useLogStore((s) => s.setOpen);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);

  async function runUpdateCheck(forceDialog = false) {
    try {
      const result = await checkForUpdates();
      setUpdateResult(result);
      if (forceDialog || result.available) {
        setUpdateDialogOpen(true);
      }
    } catch (e) {
      if (forceDialog) showError(String(e), "Update");
    }
  }

  async function runInstallUpdate() {
    setUpdateInstalling(true);
    setUpdateInstallProgress(null);
    try {
      const msg = await installUpdate();
      showSuccess(msg, "Update");
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        showWarning("Update installiert — bitte App manuell neu starten.");
      }
    } catch (e) {
      showError(String(e), "Update");
    } finally {
      setUpdateInstalling(false);
      setUpdateInstallProgress(null);
    }
  }

  async function openSdSelector(
    drive: string,
    mode: "backup" | "import" | "size_limit" = "backup",
  ) {
    setActiveDrive(drive);
    setPhase(mode === "backup" || mode === "size_limit" ? "confirming" : "importing");
    setLoading(true, "SD-Dateien werden gelesen…");
    try {
      const listed = await listSdFiles(drive);
      openSelector({
        drive,
        files: listed.files,
        totalMb: listed.total_size_mb,
        mode,
      });
      // EXIF / "bekannt" in background — dialog already open with mtime dates.
      const gen = ++sdEnrichGenRef.current;
      const paths = listed.files.map((f) => f.path);
      void enrichSdFiles(drive, paths)
        .then((updates) => {
          if (gen !== sdEnrichGenRef.current) return;
          const st = useSdStore.getState();
          if (!st.selectorOpen || st.selectorDrive !== drive) return;
          patchSelectorFiles(updates);
        })
        .catch(() => undefined);
    } catch (e) {
      showError(String(e));
    } finally {
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
    if (result.imported_videos.length > 0) {
      await addVideos(result.imported_videos);
    }
    if (result.imported_photos.length > 0) {
      await addPhotos(result.imported_photos);
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
    // Overlay stays suppressed while selectorSubmitting; message feeds SD progress.
    setLoading(true, "QR-Scan…");
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

  /** Unified SD pipeline: backup → import → optional eject; clear only after successful backup.
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

    if (!doBackup && !doImport) {
      showWarning(
        actions.clear
          ? "Bereinigen ist nur nach einem Backup möglich."
          : "Keine Aktion ausgewählt.",
      );
      return false;
    }

    if (doBackup && !config?.sd_backup_folder?.trim()) {
      showError("Bitte in den Einstellungen einen Backup-Ordner wählen.");
      return false;
    }

    hooks?.onStart?.();
    useSdStore.getState().setWorkflowActive(true);
    setLoading(true, "SD-Verarbeitung…");
    const statusActions: DialogActionStatus[] = [];
    let qrHit: AutoQrScanOutcome | null = null;

    try {
      let importPaths: string[] = selectedPaths ? [...selectedPaths] : [];

      if (doBackup) {
        setPhase("backing_up");
        setLoading(true, "SD-Backup läuft…");
        const res = await backupSdCard(drive, selectedPaths, doClear);
        if (!res.success) {
          showError(
            (res.error_message || "Backup fehlgeschlagen") +
              (actions.clear
                ? "\n\nSD wurde nicht bereinigt (kein erfolgreiches Backup)."
                : ""),
          );
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
        statusActions.push({
          kind: "backup",
          label: "Backup",
          tone: res.secondary_warning?.trim() ? "warning" : "success",
          summary: `${res.copied_count} Dateien kopiert`,
          detail: backupDetails.length ? backupDetails.join("\n") : undefined,
        });
        if (doClear) {
          if (res.copied_count > 0) {
            statusActions.push({
              kind: "clear",
              label: "SD bereinigen",
              tone: "success",
              summary: "SD nach Backup bereinigt",
            });
          } else {
            statusActions.push({
              kind: "clear",
              label: "SD bereinigen",
              tone: "skipped",
              summary: "Nicht bereinigt (keine Dateien im Backup)",
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

      if (doEject) {
        setLoading(true, "SD-Karte wird ausgeworfen…");
        try {
          await ejectSdCard(drive);
          statusActions.push({
            kind: "eject",
            label: "Auswerfen",
            tone: "success",
            summary: "SD-Karte ausgeworfen — kann sicher entfernt werden",
            detail: drive,
          });
        } catch (e) {
          statusActions.push({
            kind: "eject",
            label: "Auswerfen",
            tone: "error",
            summary: "Auswerfen fehlgeschlagen",
            detail: `${String(e)}\nBitte die Karte manuell sicher entfernen.`,
          });
        }
      }

      if (statusActions.length) {
        // Show QR first when present, then backup / import / clear / eject.
        const order: Record<DialogActionStatus["kind"], number> = {
          qr: 0,
          backup: 1,
          import: 2,
          clear: 3,
          eject: 4,
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

        showSuccess("", title, {
          ...(qrHit?.applied || qrHit?.keptExisting
            ? (qrHit.successOptions ?? {
                variant: "qr" as const,
                highlight: qrHit.kundeName || "Kunde erkannt",
              })
            : {}),
          autoCloseSecs: 10,
          actions: statusActions,
        });
      }
      return true;
    } catch (e) {
      showError(String(e));
      return true;
    } finally {
      setLoading(false);
      useSdStore.getState().setWorkflowActive(false);
      setPhase("monitoring");
      useSdStore.getState().setBackupProgress(null);
      useSdStore.getState().setWorkflowProgress(null);
    }
  }

  /**
   * Auto mode: LoadingOverlay while listing the card (like Confirm),
   * then sticky ProgressIndicator panel for the actual workflow.
   */
  async function runAutoSdWorkflow(drive: string, actions: SdWorkflowActions) {
    setActiveDrive(drive);
    setAutoPanelActive(false);
    setLoading(true, "SD-Dateien werden gelesen…");
    try {
      await listSdFiles(drive);
      await runSdWorkflow(drive, null, actions, {
        onStart: () => setAutoPanelActive(true),
      });
    } catch (e) {
      showError(String(e));
    } finally {
      setAutoPanelActive(false);
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

  // Nach Abschluss kurz anzeigen, dann ausblenden (sonst bleibt percent=100 sichtbar).
  useEffect(() => {
    if (busy || (percent <= 0 && taskProgress.length === 0)) return;
    const t = window.setTimeout(() => {
      setPercent(0);
      setStatus("");
      setTaskProgress([]);
    }, 3500);
    return () => window.clearTimeout(t);
  }, [busy, percent, taskProgress.length]);

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

  async function startCreate() {
    if (busy || autoPanelActive || loading || selectorSubmitting || qrScanBusy)
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
      const res: CreateJobResult = await createJob(kunde, paths, photos, {
        watermark_clip_index: watermarkClipIndex,
        watermark_photo_indices: wmPhotos,
        dauer: config?.dauer ?? 5,
        intro_enabled: config?.intro_enabled ?? false,
        video_codec: codec === "h265" || codec === "h264" ? codec : "auto",
        crf: config?.preview_encode_crf ?? 18,
        parallel_enabled: config?.parallel_processing_enabled ?? true,
        intro_mux_mode: config?.intro_mux_mode ?? "reencode",
        hw_accel_enabled: config?.hardware_acceleration_enabled ?? false,
        reuse_preview_path: canReusePreview ? cachedPreviewPath : null,
        reuse_preview_fingerprint: canReusePreview
          ? cachedPreviewFingerprint
          : null,
      });

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
    const cancellingQr = qrScanBusy && !busy;
    try {
      await invoke("cancel_encode");
      if (!cancellingQr) {
        setStatus("cancelled");
        showWarning("Vorgang abgebrochen.");
      }
      // QR: callers show "QR-Scan abgebrochen." once the scan returns.
    } catch (e) {
      if (!isCancellationError(e)) showError(String(e));
    }
  }

  async function handleSelectorConfirm(paths: string[], actions: SdWorkflowActions) {
    const drive = selectorDrive;
    if (!drive) return;
    try {
      const ran = await runSdWorkflow(drive, paths, actions, {
        onStart: () => setSelectorSubmitting(true),
      });
      if (ran) closeSelector();
    } finally {
      setSelectorSubmitting(false);
    }
  }

  async function handleSelectorProceedAll(actions: SdWorkflowActions) {
    const drive = selectorDrive;
    if (!drive) return;
    try {
      const ran = await runSdWorkflow(drive, null, actions, {
        onStart: () => setSelectorSubmitting(true),
      });
      if (ran) closeSelector();
    } finally {
      setSelectorSubmitting(false);
    }
  }

  function handleSessionReset() {
    if (busy || loading || selectorSubmitting || autoPanelActive || qrScanBusy) {
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
    showSuccess("Session zurückgesetzt.", "Zurücksetzen", {
      autoCloseSecs: 5,
    });
  }

  const hwLabel = hwInfo
    ? `${hwInfo.encoder}${hwInfo.available ? "" : " (Software)"}`
    : null;

  const uploadActive = Boolean(config?.upload_to_server && serverConnected);
  const uploadBlocked = Boolean(config?.upload_to_server) && !serverConnected;
  const uploadTitle = !serverConnected
    ? uploadBlocked
      ? "Upload in den Einstellungen aktiv, Server nicht verbunden"
      : "Server nicht verbunden — Upload nicht möglich"
    : uploadActive
      ? "Aktiv — Vorgang wird nach Erstellen hochgeladen"
      : "Nach dem Erstellen auf den Server laden";

  const uiLocked =
    busy ||
    autoPanelActive ||
    selectorSubmitting ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;
  const sdAutoProgress = resolveSdSelectorProgress({
    submitting: autoPanelActive,
    phase: sdPhase,
    backupProgress,
    workflowProgress,
    loadingMessage,
    qrBusy: qrScanBusy,
    qrStage: qrScanStage,
    qrByPath: qrScanByPath,
    qrFollowup,
  });
  /** Drop / Datei- / Ordner-Import — same sticky Fortschritt panel as SD Auto. */
  const mediaImporting = videoImporting || photoImporting;
  const manualImportProgress =
    !autoPanelActive && !selectorSubmitting && !qrScanBusy
      ? workflowProgress && workflowProgress.stage === "import"
        ? {
            percent: workflowProgress.percent,
            label: formatWorkflowLabel(workflowProgress, "Importiere…"),
            detail: formatWorkflowDetail(workflowProgress),
            indeterminate: false as boolean | undefined,
          }
        : mediaImporting
          ? {
              percent: 0,
              label: "Importiere…",
              detail: undefined as string | undefined,
              indeterminate: true,
            }
          : null
      : null;
  /** Same ProgressIndicator as SD Auto — for drop/manual QR (Confirm uses the dialog). */
  const manualQrProgress =
    qrScanBusy && !autoPanelActive && !selectorSubmitting
      ? summarizeQrScanProgress(qrScanByPath, qrScanStage, qrFollowup)
      : null;
  const showCreateProgress =
    busy || percent > 0 || taskProgress.length > 0;
  const showSdAutoProgress = Boolean(autoPanelActive && sdAutoProgress);
  const showManualImportProgress = Boolean(manualImportProgress);
  const showManualQrProgress = Boolean(manualQrProgress);
  const showProgressPanel =
    showCreateProgress ||
    showSdAutoProgress ||
    showManualImportProgress ||
    showManualQrProgress;

  return (
    <div className="flex h-full min-h-screen flex-col text-foreground">
      <SplashScreen
        open={splashOpen}
        status={splashStatus}
        version={appVersion}
        error={splashError}
      />

      <header className="ats-header-bg sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft ring-1 ring-primary/20">
            <img
              src="/logo.png"
              alt=""
              className="h-6 w-6 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h1 className="font-display truncate text-base font-semibold tracking-tight text-primary">
                Aero Tandem Studio
              </h1>
              <span className="text-[11px] text-muted">v{appVersion}</span>
            </div>
            <p className="truncate text-xs text-muted">
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
        <div className="flex flex-wrap items-center justify-end gap-1.5">
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
            <History className="h-4 w-4" />
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
          <ThemeToggle />
          <LogConsoleToggleButton disabled={!ready} />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="Einstellungen"
            disabled={!ready}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="ats-sidebar-bg flex w-full max-w-md flex-col border-r border-border backdrop-blur-md sm:w-[400px]">
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="border-b border-border/40 px-3 pt-1.5 pb-1.5">
              <CustomerSessionStrip disabled={uiLocked} />
            </div>
            <div className="p-4">
              <CustomerForm disabled={uiLocked} crewDisabled={busy} />
            </div>
          </div>

          <div className="space-y-2.5 border-t border-border bg-gradient-to-t from-card/90 to-card/40 p-3.5 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                  Vorgang
                </p>
                <p
                  className="truncate text-xs text-foreground/80"
                  title={config?.speicherort || undefined}
                >
                  {config?.speicherort?.trim()
                    ? config.speicherort
                    : "Speicherort beim Erstellen wählen…"}
                </p>
              </div>
              <label
                htmlFor="vorgang-upload"
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                  uploadActive
                    ? "border-primary/40 bg-primary/10 text-primary"
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
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label className="flex items-center gap-2 text-xs text-muted">
                <Checkbox
                  checked={Boolean(config?.auto_clear_files_after_creation)}
                  disabled={uiLocked || !config}
                  onCheckedChange={(v) => {
                    if (!config) return;
                    void persistConfig({
                      ...config,
                      auto_clear_files_after_creation: v === true,
                    });
                  }}
                />
                Nach Erstellen zurücksetzen
              </label>
            </div>
            {createHints.length > 0 && (
              <ul className="space-y-0.5 text-[11px] leading-snug text-muted">
                {createHints.slice(0, 4).map((h) => (
                  <li key={h}>• {h}</li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="shrink-0"
                onClick={() => void ensureSpeicherort(true)}
                disabled={uiLocked}
                title="Speicherort ändern"
                aria-label="Ordner wählen"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                className="flex-1 gap-1.5"
                onClick={() => {
                  void startCreate();
                }}
                disabled={uiLocked || !createReady}
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
        </aside>

        <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4")}>
          {showProgressPanel && (
            <section className="ats-surface sticky top-0 z-10 rounded-xl p-4 shadow-sm backdrop-blur-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
                    Fortschritt
                  </h2>
                  <p className="text-xs text-muted">
                    {showSdAutoProgress && !busy
                      ? qrScanBusy
                        ? "SD Auto — QR-Scan (Abbrechen stoppt nur den Scan)"
                        : "SD Auto — Backup, Import und weitere Aktionen"
                      : showManualImportProgress && !busy
                        ? "Medien werden in den Arbeitsordner kopiert"
                        : showManualQrProgress && !busy
                          ? "QR-Scan — Abbrechen stoppt den Scan"
                          : busy
                            ? "Aktueller Vorgang — Abbrechen stoppt FFmpeg."
                            : "Zuletzt abgeschlossener Lauf"}
                  </p>
                </div>
                {(busy || qrScanBusy) && (
                  <Button type="button" variant="destructive" size="sm" onClick={() => void cancel()}>
                    Abbrechen
                  </Button>
                )}
              </div>
              {showSdAutoProgress && !busy && sdAutoProgress ? (
                <div className="space-y-2">
                  <ProgressIndicator
                    percent={sdAutoProgress.percent}
                    label={sdAutoProgress.label}
                    indeterminate={Boolean(sdAutoProgress.indeterminate)}
                  />
                  {sdAutoProgress.detail ? (
                    <p className="text-xs tabular-nums text-muted">
                      {sdAutoProgress.detail}
                    </p>
                  ) : null}
                </div>
              ) : showManualImportProgress && !busy && manualImportProgress ? (
                <div className="space-y-2">
                  <ProgressIndicator
                    percent={manualImportProgress.percent}
                    label={manualImportProgress.label}
                    indeterminate={Boolean(manualImportProgress.indeterminate)}
                  />
                  {manualImportProgress.detail ? (
                    <p className="text-xs tabular-nums text-muted">
                      {manualImportProgress.detail}
                    </p>
                  ) : null}
                </div>
              ) : showManualQrProgress && !busy && manualQrProgress ? (
                <div className="space-y-2">
                  <ProgressIndicator
                    percent={manualQrProgress.percent}
                    label={manualQrProgress.label}
                    indeterminate={Boolean(manualQrProgress.indeterminate)}
                  />
                  {manualQrProgress.detail ? (
                    <p className="text-xs tabular-nums text-muted">
                      {manualQrProgress.detail}
                    </p>
                  ) : null}
                </div>
              ) : (
                <ProgressIndicator
                  percent={percent}
                  label={formatOverallProgressLabel(status, busy ? "In Arbeit…" : "Fertig")}
                  tasks={taskProgress.map((t) => ({
                    taskId: t.taskId,
                    percent: t.percent,
                    label: taskProgressLabel(t.taskId, t.status),
                    status: t.status,
                  }))}
                />
              )}
            </section>
          )}

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
                  busy={busy || autoPanelActive}
                  onBusyChange={setBusy}
                  percent={percent}
                  status={status}
                  taskProgress={taskProgress}
                  onProgressReset={resetProgress}
                  formReady={createReady}
                  formHints={createHints}
                  playbackSuspended={cutterOpen}
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
                <PhotoPreview disabled={uiLocked} />
                <MediaListPanel kind="foto" disabled={uiLocked} />
              </TabsContent>
            </Tabs>
          </section>
        </main>
      </div>
      <LogConsole />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open && updateDialogOpen) return;
          setSettingsOpen(open);
        }}
        onRequestUpdateCheck={() => void runUpdateCheck(true)}
        onAfterFactoryReset={() => {
          setSettingsOpen(false);
          setSetupWizardOpen(true);
        }}
        suppressDismiss={updateDialogOpen}
      />
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
        result={updateResult}
        installing={updateInstalling}
        installProgress={updateInstallProgress}
        onInstall={() => void runInstallUpdate()}
        onLater={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
        onClose={() => {
          if (!updateInstalling) setUpdateDialogOpen(false);
        }}
      />
      <SdFileSelector
        open={selectorOpen}
        drive={selectorDrive}
        files={selectorFiles}
        totalSizeMb={selectorTotalMb}
        mode={selectorMode}
        defaultActions={settingsSdActions()}
        submitting={selectorSubmitting}
        progress={resolveSdSelectorProgress({
          submitting: selectorSubmitting,
          phase: sdPhase,
          backupProgress,
          workflowProgress,
          loadingMessage,
          qrBusy: qrScanBusy,
          qrStage: qrScanStage,
          qrByPath: qrScanByPath,
          qrFollowup,
        })}
        canCancelProgress={selectorSubmitting && qrScanBusy}
        onCancelProgress={() => void cancel()}
        onClose={() => {
          sdEnrichGenRef.current += 1;
          closeSelector();
        }}
        onConfirm={(paths, actions) => void handleSelectorConfirm(paths, actions)}
        onProceedAll={(actions) => void handleSelectorProceedAll(actions)}
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
        onClose={closeDialog}
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
      <LoadingOverlay
        open={loading && !selectorSubmitting && !autoPanelActive}
        message={loadingMessage}
      />
    </div>
  );
}

export default App;
