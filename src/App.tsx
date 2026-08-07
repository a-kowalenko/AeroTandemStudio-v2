import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { History, RotateCcw, Settings } from "lucide-react";
import { ProgressIndicator } from "./components/ProgressIndicator";
import { MediaDropZone } from "./components/MediaDropZone";
import { VideoPreview } from "./components/VideoPreview";
import { PhotoPreview } from "./components/PhotoPreview";
import { VideoCutter, type VideoCutterResult } from "./components/VideoCutter";
import { PendingCutsDialog } from "./components/PendingCutsDialog";
import { CustomerForm, CustomerFormToolbar } from "./components/CustomerForm";
import { SettingsDialog } from "./components/SettingsDialog";
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
import { SdStatusIndicator } from "./components/SdStatusIndicator";
import { ServerStatusIndicator } from "./components/ServerStatusIndicator";
import { UpdateDialog } from "./components/UpdateDialog";
import { SdModeSelector } from "./components/SdModeSelector";
import { SdDriveSelector } from "./components/SdDriveSelector";
import { SdFileSelector } from "./components/SdFileSelector";
import { ProcessedFilesDialog } from "./components/ProcessedFilesDialog";
import { ThemeToggle } from "./components/ThemeToggle";
import { LogConsole, LogConsoleToggleButton } from "./components/LogConsole";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { useVideoStore } from "./store/videoStore";
import { usePhotoStore } from "./store/photoStore";
import { useConfigStore } from "./store/configStore";
import { useKundeStore } from "./store/kundeStore";
import { useUiStore } from "./store/uiStore";
import { useSdStore } from "./store/sdStore";
import { useServerStore } from "./store/serverStore";
import { usePreviewCacheStore, previewEncodingSignature } from "./store/previewCacheStore";
import { useSdCardMonitor } from "./hooks/useSdCardMonitor";
import { usePendingVideoCuts } from "./hooks/usePendingVideoCuts";
import { useLogListener } from "./hooks/useLogListener";
import { useLogStore } from "./store/logStore";
import {
  checkForUpdates,
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
import { importSdFiles, listSdFiles } from "./lib/sdCard";
import { pathsAddedSince, runAutoQrAfterImport } from "./lib/autoQrScan";
import { withQrScanProgress } from "./store/qrScanStore";
import { useQrScanProgressListener } from "./hooks/useQrScanProgress";
import { applyMonotonicPercent, resolveProgressLabel, shouldClearTaskProgress, taskProgressLabel } from "./lib/progressLabels";
import { cn, isCancellationError } from "./lib/utils";
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
  const closeDialog = useUiStore((s) => s.closeDialog);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);
  const loading = useUiStore((s) => s.loading);
  const loadingMessage = useUiStore((s) => s.loadingMessage);
  const setLoading = useUiStore((s) => s.setLoading);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

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
  const processedOpen = useSdStore((s) => s.processedOpen);
  const setProcessedOpen = useSdStore((s) => s.setProcessedOpen);
  const setPhase = useSdStore((s) => s.setPhase);
  useSdStore((s) => s.activeDrive);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);

  const [hwInfo, setHwInfo] = useState<HwAccelInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState("");
  const [taskProgress, setTaskProgress] = useState<TaskProgressState[]>([]);
  /** Shared media list + preview tab (video | foto). */
  const [mediaTab, setMediaTab] = useState<"video" | "foto">("video");
  const photoList = usePhotoStore((s) => s.photoList);
  const defaultsApplied = useRef(false);
  const [cutterOpen, setCutterOpen] = useState(false);
  const [cutterPath, setCutterPath] = useState<string | null>(null);
  const [cutterIndex, setCutterIndex] = useState(0);
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
  const [createReady, setCreateReady] = useState(false);
  const [createHints, setCreateHints] = useState<string[]>([]);
  const [createSuccess, setCreateSuccess] = useState<CreateSuccessInfo | null>(null);
  const [introMuxFallback, setIntroMuxFallback] = useState<{
    reason: string;
    timeoutSecs: number;
  } | null>(null);

  const pendingCuts = usePendingVideoCuts();
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
    mode: "backup" | "import" = "import",
  ) {
    setActiveDrive(drive);
    setPhase(mode === "backup" ? "detected" : "importing");
    setLoading(true, "SD-Dateien werden gelesen…");
    try {
      const listed = await listSdFiles(drive);
      openSelector({
        drive,
        files: listed.files,
        totalMb: listed.total_size_mb,
        mode,
      });
    } catch (e) {
      showError(String(e));
    } finally {
      setLoading(false);
      setPhase("monitoring");
    }
  }

  function openSdImport(drive: string) {
    return openSdSelector(drive, "import");
  }

  function openSdDriveFromHeader(drive: string) {
    const mode =
      config?.sd_auto_backup && config.sd_backup_mode !== "disabled"
        ? "backup"
        : "import";
    return openSdSelector(drive, mode);
  }

  const { runBackup } = useSdCardMonitor({
    onRequestImport: (drive) => {
      void openSdImport(drive);
    },
  });

  async function handleSdPrimaryAction(drive: string) {
    if (config?.sd_auto_backup && config.sd_backup_mode !== "disabled") {
      await runBackup(drive, null);
      return;
    }
    await openSdSelector(drive, "import");
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
  }, [loadConfig, showError]);

  useEffect(() => {
    if (!config?.server_url || !ready) return;
    void checkServerConnection();
  }, [config?.server_url, config?.server_login, checkServerConnection, ready]);

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
          return resolveProgressLabel(p.status, prev);
        });
      } else {
        setPercent((prev) => applyMonotonicPercent(prev, p.percent));
        const label = resolveProgressLabel(p.status, undefined);
        setStatus((prev) => resolveProgressLabel(p.status, prev));
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
          if (pendingCuts.count > 0) {
            hints.push(
              `${pendingCuts.count} geplante(r) Schnitt(e) — bitte zuerst Warteschlange anwenden.`,
            );
          }
          setCreateHints(hints);
          setCreateReady(validation.valid && pendingCuts.count === 0);
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
    pendingCuts.count,
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
    if (pendingCuts.count > 0) {
      showWarning(
        `Es liegen noch ${pendingCuts.count} geplante Videoschnitte in der Warteschlange.\n\nBitte zuerst „Warteschlange anwenden“, bevor „Erstellen“ startet.`,
        "Ausstehende Schnitte",
      );
      return;
    }

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
        Boolean(config?.intro_enabled ?? true),
        config?.dauer ?? 5,
        config?.intro_mux_mode ?? "reencode",
      );
      const canReusePreview = previewCacheMatches(videoList, kunde, encodingSig);
      const res: CreateJobResult = await createJob(kunde, paths, photos, {
        watermark_clip_index: watermarkClipIndex,
        watermark_photo_indices: wmPhotos,
        dauer: config?.dauer ?? 5,
        intro_enabled: config?.intro_enabled ?? true,
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
      });
      setPercent(100);
      setStatus("Vorgang fertig");
      setTaskProgress([]);

      if (config?.auto_clear_files_after_creation) {
        pendingCuts.clearAll();
        clearVideos();
        clearPhotos();
        clearPreviewCache();
        void clearWorkingSession();
        resetSession({
          tandemmaster: config.keep_tandemmaster_on_session_reset,
          videospringer: config.keep_videospringer_on_session_reset,
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
    try {
      await invoke("cancel_encode");
      setStatus("cancelled");
      showWarning("Vorgang abgebrochen.");
    } catch (e) {
      if (!isCancellationError(e)) showError(String(e));
    }
  }

  async function handleSelectorConfirm(paths: string[]) {
    const drive = selectorDrive;
    const modeSel = selectorMode;
    closeSelector();
    if (!drive) return;

    if (modeSel === "backup" || modeSel === "size_limit") {
      await runBackup(drive, paths);
      return;
    }

    setLoading(true, "Importiere SD-Dateien…");
    setPhase("importing");
    try {
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

      const willAutoScan =
        (config?.qr_check_enabled && newVideoPaths.length > 0) ||
        (config?.photo_qr_check_enabled && newPhotoPaths.length > 0);

      let qrNote = "";
      if (willAutoScan) {
        setLoading(false);
        try {
          const outcome = await withQrScanProgress(
            [...newVideoPaths, ...newPhotoPaths],
            () =>
              runAutoQrAfterImport({
                videoPaths: newVideoPaths,
                photoPaths: newPhotoPaths,
                onBeforeRemoveVideo: (p) => pendingCuts.discardForPath(p),
              }),
          );
          if (outcome.attempted && outcome.found) {
            qrNote = `\nAuto-QR: ${outcome.message}`;
          } else if (outcome.attempted) {
            qrNote = `\nAuto-QR: ${outcome.message}`;
          }
        } catch (qrErr) {
          qrNote = `\nAuto-QR fehlgeschlagen: ${String(qrErr)}`;
        }
      }

      showSuccess(
        `Import: ${result.imported_videos.length} Videos, ${result.imported_photos.length} Fotos` +
          (result.skipped ? `, ${result.skipped} übersprungen` : "") +
          qrNote,
      );
    } catch (e) {
      showError(String(e));
    } finally {
      setLoading(false);
      setPhase("monitoring");
    }
  }

  function handleSessionReset() {
    if (busy || loading) {
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
    pendingCuts.clearAll();
    clearVideos();
    clearPhotos();
    clearPreviewCache();
    void clearWorkingSession();
    resetSession({
      tandemmaster: config?.keep_tandemmaster_on_session_reset,
      videospringer: config?.keep_videospringer_on_session_reset,
    });
    showSuccess("Session zurückgesetzt.", "Zurücksetzen");
  }

  const hwLabel = hwInfo
    ? `${hwInfo.encoder}${hwInfo.available ? "" : " (Software)"}`
    : null;

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
              {hwLabel ? `Encoder: ${hwLabel}` : ready ? "Bereit" : "Start…"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SdDriveSelector
            disabled={busy || !ready}
            onOpenDrive={(drive) => void openSdDriveFromHeader(drive)}
            onPrimaryAction={(drive) => void handleSdPrimaryAction(drive)}
          />
          <SdModeSelector visible={Boolean(config?.sd_auto_backup)} />
          <SdStatusIndicator />
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
            disabled={busy || !ready}
            title="Formular und Medien zurücksetzen"
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
          <div className="flex items-center gap-3 border-b border-border/80 px-4 py-3">
            <h2 className="shrink-0 text-sm font-semibold tracking-wide text-muted uppercase">
              Kunde
            </h2>
            <CustomerFormToolbar disabled={busy} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <CustomerForm disabled={busy} />
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
              <label className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card-elevated/80 px-2 py-1 text-xs text-muted">
                <Checkbox
                  checked={Boolean(config?.upload_to_server)}
                  disabled={busy || !config}
                  onCheckedChange={(v) => {
                    if (!config) return;
                    const enabled = v === true;
                    if (enabled && !serverConnected) {
                      showWarning(
                        "Server nicht erreichbar — Upload bleibt deaktiviert.",
                        "Server",
                      );
                      void checkServerConnection();
                      return;
                    }
                    void persistConfig({ ...config, upload_to_server: enabled });
                  }}
                />
                Upload
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label className="flex items-center gap-2 text-xs text-muted">
                <Checkbox
                  checked={Boolean(config?.auto_clear_files_after_creation)}
                  disabled={busy || !config}
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
              <label className="flex items-center gap-2 text-xs text-muted">
                <Checkbox
                  checked={Boolean(config?.intro_enabled)}
                  disabled={busy || !config}
                  onCheckedChange={(v) => {
                    if (!config) return;
                    void persistConfig({
                      ...config,
                      intro_enabled: v === true,
                    });
                  }}
                />
                Intro erstellen
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
                size="sm"
                className="shrink-0"
                onClick={() => void ensureSpeicherort(true)}
                disabled={busy}
                title="Speicherort ändern"
              >
                Ordner…
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  void startCreate();
                }}
                disabled={busy || !createReady}
              >
                Erstellen
              </Button>
            </div>
          </div>
        </aside>

        <main className={cn("flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4")}>
          {(busy || percent > 0 || taskProgress.length > 0) && (
            <section className="ats-surface sticky top-0 z-10 rounded-xl p-4 shadow-sm backdrop-blur-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
                    {busy ? "Erstellungsfortschritt" : "Fortschritt"}
                  </h2>
                  <p className="text-xs text-muted">
                    {busy
                      ? "Aktuelle Schritte und Clips — Abbrechen stoppt FFmpeg und den Vorgang."
                      : "Zuletzt abgeschlossener Lauf"}
                  </p>
                </div>
                {busy && (
                  <Button type="button" variant="destructive" size="sm" onClick={() => void cancel()}>
                    Abbrechen
                  </Button>
                )}
              </div>
              <ProgressIndicator
                percent={percent}
                label={resolveProgressLabel(status, busy ? "In Arbeit…" : "Fertig")}
                tasks={taskProgress.map((t) => ({
                  taskId: t.taskId,
                  percent: t.percent,
                  label: taskProgressLabel(t.taskId, t.status),
                  status: t.status,
                }))}
              />
            </section>
          )}

          <MediaDropZone
            pendingCutsCount={pendingCuts.count}
            onOpenPendingCuts={pendingCuts.openReview}
            onRemoveVideo={pendingCuts.discardForPath}
            listTab={mediaTab}
            onListTabChange={setMediaTab}
            onImported={({ videosAdded, photosAdded }) => {
              if (photosAdded > 0 && videosAdded === 0) setMediaTab("foto");
              else if (videosAdded > 0) setMediaTab("video");
            }}
          />

          <section className="ats-surface space-y-3 rounded-xl p-4 shadow-sm backdrop-blur-sm">
            <Tabs
              value={mediaTab}
              onValueChange={(v) => setMediaTab(v === "foto" ? "foto" : "video")}
              className="w-full"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
                    Vorschau
                  </h2>
                  <p className="text-xs text-muted">
                    {mediaTab === "video"
                      ? "Player, Cutter & Preview-Encode"
                      : "Galerie, Auswahl & QR-Scan"}
                  </p>
                </div>
                <TabsList>
                  <TabsTrigger value="video" className="gap-1.5">
                    Video
                    {videoList.length > 0 && (
                      <span className="tabular-nums text-muted">({videoList.length})</span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="foto" className="gap-1.5">
                    Foto
                    {photoList.length > 0 && (
                      <span className="tabular-nums text-muted">({photoList.length})</span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="video" className="mt-3 space-y-4">
                <VideoPreview
                  busy={busy}
                  onBusyChange={setBusy}
                  percent={percent}
                  status={status}
                  taskProgress={taskProgress}
                  onProgressReset={resetProgress}
                  formReady={createReady}
                  formHints={createHints}
                  onCutClip={(path, listIndex) => {
                    const meta = videoList.find((v) => v.path === path);
                    setCutterPath(path);
                    setCutterIndex(listIndex >= 0 ? listIndex : pendingCuts.indexForPath(path));
                    setCutterDuration(meta?.duration_secs ?? 0);
                    setCutterOpen(true);
                  }}
                  onBeforeRemoveClip={pendingCuts.discardForPath}
                />
              </TabsContent>
              <TabsContent value="foto" className="mt-3">
                <PhotoPreview disabled={busy} />
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
        suppressDismiss={updateDialogOpen}
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
        onClose={closeSelector}
        onConfirm={(paths) => void handleSelectorConfirm(paths)}
        onProceedAll={() => {
          const drive = selectorDrive;
          closeSelector();
          if (drive) void runBackup(drive, null);
        }}
      />
      <ProcessedFilesDialog open={processedOpen} onOpenChange={setProcessedOpen} />
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
          const idx = cutterIndex >= 0 ? cutterIndex : pendingCuts.indexForPath(cutterPath);
          if (result.action === "queue_trim") {
            pendingCuts.enqueueTrim(cutterPath, idx, result.startMs, result.endMs);
            showSuccess("Trim in die Warteschlange gelegt.");
          } else if (result.action === "queue_split") {
            pendingCuts.enqueueSplit(cutterPath, idx, result.splitMs);
            showSuccess("Split in die Warteschlange gelegt.");
          }
        }}
      />
      <PendingCutsDialog
        open={pendingCuts.reviewOpen}
        onOpenChange={pendingCuts.setReviewOpen}
        summaries={pendingCuts.summaries}
        onRemoveAt={pendingCuts.removeAt}
        onClearAll={pendingCuts.clearAll}
        applying={pendingCuts.applying}
        onApply={() => {
          void pendingCuts.applyAll({
            onBusyChange: setBusy,
            onProgressReset: resetProgress,
          });
        }}
      />
      <ErrorDialog
        open={dialogKind === "error"}
        title={dialogTitle}
        message={dialogMessage}
        onClose={closeDialog}
      />
      <SuccessDialog
        open={dialogKind === "success"}
        title={dialogTitle}
        message={dialogMessage}
        autoCloseSecs={dialogAutoCloseSecs}
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
      <LoadingOverlay open={loading} message={loadingMessage} />
    </div>
  );
}

export default App;
