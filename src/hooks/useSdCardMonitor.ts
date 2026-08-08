import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getSdStatus,
  scanSdDrives,
  startSdMonitor,
  type BackupProgress,
  type SdInsertedPayload,
  type SdWorkflowActions,
} from "../lib/sdCard";
import { useConfigStore } from "../store/configStore";
import { useSdStore } from "../store/sdStore";
import { useUiStore } from "../store/uiStore";

/**
 * Starts SD monitoring when config allows it and wires Tauri events into sdStore.
 */
export function useSdCardMonitor(opts?: {
  /** Confirm / size-limit: open file selector for the drive. */
  onRequestSelect?: (drive: string, mode: "backup" | "size_limit") => void;
  /** Auto mode: run backup/import/clear from settings without a dialog. */
  onAutoProcess?: (drive: string, actions: SdWorkflowActions) => void;
}) {
  const onRequestSelectRef = useRef(opts?.onRequestSelect);
  onRequestSelectRef.current = opts?.onRequestSelect;
  const onAutoProcessRef = useRef(opts?.onAutoProcess);
  onAutoProcessRef.current = opts?.onAutoProcess;

  const config = useConfigStore((s) => s.config);
  const setMonitoring = useSdStore((s) => s.setMonitoring);
  const setDrives = useSdStore((s) => s.setDrives);
  const setPhase = useSdStore((s) => s.setPhase);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const setPendingInsert = useSdStore((s) => s.setPendingInsert);
  const setBackupProgress = useSdStore((s) => s.setBackupProgress);
  const showError = useUiStore((s) => s.showError);

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

      const mode = config?.sd_backup_mode ?? "confirm";
      if (mode === "disabled" || !config?.sd_auto_backup) {
        return;
      }

      if (payload.size_limit_exceeded) {
        onRequestSelectRef.current?.(payload.drive, "size_limit");
        return;
      }

      if (payload.needs_confirmation || mode === "confirm") {
        onRequestSelectRef.current?.(payload.drive, "backup");
        return;
      }

      // Auto: run enabled actions without a dialog.
      // Clear only together with backup (same rule as Confirm).
      const actionsSafe: SdWorkflowActions = {
        backup: true,
        import: Boolean(config.sd_auto_import),
        clear: Boolean(config.sd_clear_after_backup),
      };

      if (actionsSafe.backup || actionsSafe.import) {
        onAutoProcessRef.current?.(payload.drive, actionsSafe);
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
    config?.sd_auto_backup,
    config?.sd_auto_import,
    config?.sd_backup_mode,
    config?.sd_clear_after_backup,
    setActiveDrive,
    setBackupProgress,
    setDrives,
    setPendingInsert,
    setPhase,
  ]);
}
