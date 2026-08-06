import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  backupSdCard,
  declineSdBackup,
  getSdStatus,
  listSdFiles,
  scanSdDrives,
  startSdMonitor,
  type BackupProgress,
  type SdInsertedPayload,
} from "../lib/sdCard";
import { useConfigStore } from "../store/configStore";
import { useSdStore } from "../store/sdStore";
import { useUiStore } from "../store/uiStore";

/**
 * Starts SD monitoring when config allows it and wires Tauri events into sdStore.
 */
export function useSdCardMonitor(opts?: {
  onRequestImport?: (drive: string) => void;
}) {
  const onRequestImportRef = useRef(opts?.onRequestImport);
  onRequestImportRef.current = opts?.onRequestImport;

  const config = useConfigStore((s) => s.config);
  const setMonitoring = useSdStore((s) => s.setMonitoring);
  const setDrives = useSdStore((s) => s.setDrives);
  const setPhase = useSdStore((s) => s.setPhase);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const setPendingInsert = useSdStore((s) => s.setPendingInsert);
  const setBackupProgress = useSdStore((s) => s.setBackupProgress);
  const openSelector = useSdStore((s) => s.openSelector);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const showWarning = useUiStore((s) => s.showWarning);
  const setLoading = useUiStore((s) => s.setLoading);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getSdStatus();
        if (cancelled) return;
        setMonitoring(status.monitoring);
        setDrives(status.drives);
        if (status.drives[0]) setActiveDrive(status.drives[0].drive);
      } catch {
        // ignore — backend may not be ready in browser-only preview
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setMonitoring, setDrives, setActiveDrive]);

  useEffect(() => {
    if (!config?.sd_auto_backup) return;
    let cancelled = false;
    (async () => {
      try {
        const ok = await startSdMonitor();
        if (!cancelled) setMonitoring(ok);
      } catch (e) {
        if (!cancelled) showError(String(e), "SD-Monitor");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config?.sd_auto_backup, setMonitoring, showError]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen<SdInsertedPayload>("sd-card-inserted", async (event) => {
      const payload = event.payload;
      setPendingInsert(payload);
      setActiveDrive(payload.drive);
      setPhase(payload.needs_confirmation ? "confirming" : "detected");
      try {
        const drives = await scanSdDrives();
        setDrives(drives);
      } catch {
        /* ignore */
      }

      if (payload.size_limit_exceeded) {
        try {
          const listed = await listSdFiles(payload.drive);
          openSelector({
            drive: payload.drive,
            files: listed.files,
            totalMb: listed.total_size_mb,
            mode: "size_limit",
          });
        } catch (e) {
          showError(String(e));
        }
        return;
      }

      if (payload.needs_confirmation) {
        showWarning(
          `SD-Karte ${payload.drive} erkannt (${payload.file_count} Dateien, ${payload.total_size_mb.toFixed(1)} MB).\n` +
            `Backup starten? Öffne den Dateiauswahl-Dialog über „SD öffnen“.`,
          "SD-Karte erkannt",
        );
      } else if (config?.sd_auto_import) {
        onRequestImportRef.current?.(payload.drive);
      }
    }).then((fn) => unlisteners.push(fn));

    listen<{ drives: string[] }>("sd-card-removed", (event) => {
      const removed = event.payload.drives ?? [];
      setPhase("monitoring");
      setPendingInsert(null);
      setBackupProgress(null);
      if (removed.length) {
        setActiveDrive(null);
        void scanSdDrives().then(setDrives).catch(() => undefined);
      }
    }).then((fn) => unlisteners.push(fn));

    listen<BackupProgress>("sd-backup-progress", (event) => {
      setPhase("backing_up");
      setBackupProgress(event.payload);
    }).then((fn) => unlisteners.push(fn));

    listen<{ kind: string; data: unknown }>("sd-backup-status", (event) => {
      const kind = event.payload.kind;
      if (kind === "backup_started") setPhase("backing_up");
      if (kind === "clearing_started") setPhase("clearing");
      if (kind === "clearing_finished") setPhase("backing_up");
      if (kind === "backup_finished") {
        setPhase("monitoring");
        setBackupProgress(null);
      }
      if (kind === "backup_confirmation_required") {
        setPhase("confirming");
      }
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const u of unlisteners) u();
    };
  }, [
    config?.sd_auto_import,
    openSelector,
    setActiveDrive,
    setBackupProgress,
    setDrives,
    setPendingInsert,
    setPhase,
    showError,
    showWarning,
  ]);

  async function runBackup(drive: string, selected?: string[] | null) {
    setPhase("backing_up");
    setLoading(true, "SD-Backup läuft…");
    try {
      const res = await backupSdCard(drive, selected);
      if (res.success) {
        showSuccess(
          `Backup OK: ${res.copied_count} Dateien` +
            (res.backup_path ? `\n${res.backup_path}` : "") +
            (res.skipped_count ? `\nÜbersprungen: ${res.skipped_count}` : ""),
        );
        if (config?.sd_auto_import) {
          onRequestImportRef.current?.(drive);
        }
      } else {
        showError(res.error_message || "Backup fehlgeschlagen");
      }
    } catch (e) {
      showError(String(e));
    } finally {
      setLoading(false);
      setPhase("monitoring");
      setBackupProgress(null);
    }
  }

  async function decline(drive: string) {
    await declineSdBackup(drive);
    setPendingInsert(null);
    setPhase("monitoring");
  }

  return { runBackup, decline };
}
