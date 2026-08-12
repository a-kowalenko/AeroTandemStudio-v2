import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getSdStatus,
  scanSdDrives,
  startSdMonitor,
  type BackupProgress,
  type SdInsertedPayload,
  type SdWorkflowActions,
  type SecondaryBackupEvent,
  type WorkflowProgress,
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
  const setWorkflowProgress = useSdStore((s) => s.setWorkflowProgress);
  const setSecondaryBackup = useSdStore((s) => s.setSecondaryBackup);
  const showError = useUiStore((s) => s.showError);
  const showWarning = useUiStore((s) => s.showWarning);

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
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    // Heal "Import…" stuck from media import emitting the shared SD progress event.
    const { workflowActive, phase } = useSdStore.getState();
    if (!workflowActive && (phase === "importing" || phase === "clearing")) {
      setPhase("monitoring");
      setWorkflowProgress(null);
      setBackupProgress(null);
    }

    void (async () => {
      unlisteners.push(
        await listen<SdInsertedPayload>("sd-card-inserted", (event) => {
          const payload = event.payload;
          const cfg = useConfigStore.getState().config;

          setPendingInsert(payload);
          setActiveDrive(payload.drive);
          setPhase(payload.needs_confirmation ? "confirming" : "detected");

          void scanSdDrives()
            .then(setDrives)
            .catch(() => undefined);

          if (!cfg?.sd_auto_backup || cfg.sd_backup_mode === "disabled") {
            return;
          }

          if (payload.size_limit_exceeded) {
            onRequestSelectRef.current?.(payload.drive, "size_limit");
            return;
          }

          // Trust backend `needs_confirmation` — do not re-check frontend mode here
          // (stale listeners with old mode caused dialog + auto in parallel).
          if (payload.needs_confirmation) {
            onRequestSelectRef.current?.(payload.drive, "backup");
            return;
          }

          const actionsSafe: SdWorkflowActions = {
            backup: true,
            import: Boolean(cfg.sd_auto_import),
            clear: Boolean(cfg.sd_clear_after_backup),
            eject: Boolean(cfg.sd_eject_after_workflow),
          };

          if (actionsSafe.backup || actionsSafe.import) {
            onAutoProcessRef.current?.(payload.drive, actionsSafe);
          }
        }),
      );

      unlisteners.push(
        await listen<{ drives: string[] }>("sd-card-removed", (event) => {
          const removed = event.payload.drives ?? [];
          setPhase("monitoring");
          setPendingInsert(null);
          setBackupProgress(null);
          setWorkflowProgress(null);
          if (removed.length) {
            setActiveDrive(null);
            void scanSdDrives().then(setDrives).catch(() => undefined);
          }
        }),
      );

      unlisteners.push(
        await listen<BackupProgress>("sd-backup-progress", (event) => {
          setPhase("backing_up");
          setWorkflowProgress(null);
          setBackupProgress(event.payload);
        }),
      );

      unlisteners.push(
        await listen<WorkflowProgress>("sd-workflow-progress", (event) => {
          const { workflowActive, phase } = useSdStore.getState();
          const p = event.payload;
          if (!workflowActive) {
            if (p.stage === "import") {
              setWorkflowProgress(p);
            }
            if (phase === "importing" || phase === "clearing") {
              setPhase("monitoring");
              if (p.stage !== "import") {
                setWorkflowProgress(null);
                setBackupProgress(null);
              }
            }
            return;
          }
          if (p.stage === "clear") setPhase("clearing");
          else if (p.stage === "import") setPhase("importing");
          setBackupProgress(null);
          setWorkflowProgress(p);
        }),
      );

      unlisteners.push(
        await listen<{ kind: string; data: unknown }>("sd-backup-status", (event) => {
          const kind = event.payload.kind;
          if (kind === "backup_started") setPhase("backing_up");
          if (kind === "clearing_started") setPhase("clearing");
          if (kind === "clearing_finished") setPhase("backing_up");
          if (kind === "backup_finished") {
            setPhase("monitoring");
          }
          if (kind === "backup_confirmation_required") {
            setPhase("confirming");
          }
        }),
      );

      unlisteners.push(
        await listen<SecondaryBackupEvent>("sd-secondary-backup", (event) => {
          const p = event.payload;
          setSecondaryBackup(p);
          if (p.state === "failed") {
            showWarning(
              p.message?.trim() || "Server-Backup (zweiter Pfad) fehlgeschlagen.",
              "Server-Backup",
            );
          }
          if (p.state === "done") {
            window.setTimeout(() => {
              const cur = useSdStore.getState().secondaryBackup;
              if (cur?.job_id === p.job_id && cur.state === "done") {
                setSecondaryBackup(null);
              }
            }, 4000);
          }
        }),
      );

      if (cancelled) {
        for (const u of unlisteners) u();
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, [
    setActiveDrive,
    setBackupProgress,
    setWorkflowProgress,
    setSecondaryBackup,
    setDrives,
    setPendingInsert,
    setPhase,
    showWarning,
  ]);
}
