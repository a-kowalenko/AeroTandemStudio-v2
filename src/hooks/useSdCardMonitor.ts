import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getSdStatus,
  scanSdDrives,
  startSdMonitor,
  type BackupProgress,
  type SdFileInfo,
  type SdInsertedPayload,
  type SdWorkflowActions,
  type SecondaryBackupEvent,
  type WorkflowProgress,
} from "../lib/sdCard";
import { jobKindFromInsert } from "../lib/sdQueue";
import {
  showSdQueueDroppedToast,
  showSdQueuedToast,
} from "../lib/sdQueueToast";
import { useConfigStore } from "../store/configStore";
import { isSdPipelineBusy, useSdStore } from "../store/sdStore";
import { useUiStore } from "../store/uiStore";

/**
 * Starts SD monitoring when config allows it and wires Tauri events into sdStore.
 */
export function useSdCardMonitor(opts?: {
  /** Confirm / size-limit: open file selector for the drive. */
  onRequestSelect?: (drive: string, mode: "backup" | "size_limit") => void;
  /** Auto mode: run backup/import/clear from settings without a dialog. */
  onAutoProcess?: (drive: string, actions: SdWorkflowActions) => void;
  /** After queue changes that may unblock the next job (e.g. card removed). */
  onRequestDrain?: () => void;
}) {
  const onRequestSelectRef = useRef(opts?.onRequestSelect);
  onRequestSelectRef.current = opts?.onRequestSelect;
  const onAutoProcessRef = useRef(opts?.onAutoProcess);
  onAutoProcessRef.current = opts?.onAutoProcess;
  const onRequestDrainRef = useRef(opts?.onRequestDrain);
  onRequestDrainRef.current = opts?.onRequestDrain;

  const config = useConfigStore((s) => s.config);
  const setMonitoring = useSdStore((s) => s.setMonitoring);
  const setDrives = useSdStore((s) => s.setDrives);
  const setPhase = useSdStore((s) => s.setPhase);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const setPendingInsert = useSdStore((s) => s.setPendingInsert);
  const setBackupProgress = useSdStore((s) => s.setBackupProgress);
  const setWorkflowProgress = useSdStore((s) => s.setWorkflowProgress);
  const setSecondaryBackup = useSdStore((s) => s.setSecondaryBackup);
  const enqueueSdJob = useSdStore((s) => s.enqueueSdJob);
  const dropQueuedDrives = useSdStore((s) => s.dropQueuedDrives);
  const closeSelector = useSdStore((s) => s.closeSelector);
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
    let catalogTimer: number | null = null;
    let pendingCatalog: {
      drive: string;
      files: SdFileInfo[];
      total_size_mb: number;
      done: boolean;
    } | null = null;

    const flushCatalog = () => {
      catalogTimer = null;
      const next = pendingCatalog;
      pendingCatalog = null;
      if (!next) return;
      useSdStore
        .getState()
        .replaceSelectorCatalog(
          next.drive,
          next.files,
          next.total_size_mb,
          next.done === false,
        );
    };

    const queueCatalog = (data: {
      drive?: string;
      files?: SdFileInfo[];
      total_size_mb?: number;
      done?: boolean;
    } | null) => {
      if (!data?.drive || !Array.isArray(data.files)) return;
      pendingCatalog = {
        drive: data.drive,
        files: data.files,
        total_size_mb: Number(data.total_size_mb) || 0,
        done: data.done !== false,
      };
      const immediate =
        pendingCatalog.done || pendingCatalog.files.length <= 24;
      if (immediate) {
        if (catalogTimer != null) window.clearTimeout(catalogTimer);
        flushCatalog();
        return;
      }
      if (catalogTimer == null) {
        catalogTimer = window.setTimeout(flushCatalog, 280);
      }
    };

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
          void scanSdDrives()
            .then(setDrives)
            .catch(() => undefined);

          if (!cfg?.sd_auto_backup || cfg.sd_backup_mode === "disabled") {
            setActiveDrive(payload.drive);
            setPhase(payload.needs_confirmation ? "confirming" : "detected");
            return;
          }

          // USB/MTP: same confirm/auto flow; listing stages via Image Capture on macOS.
          const kind = jobKindFromInsert(payload);
          const actionsSafe: SdWorkflowActions = {
            backup: true,
            import: Boolean(cfg.sd_auto_import),
            clear: Boolean(cfg.sd_clear_after_backup),
            eject: Boolean(cfg.sd_eject_after_workflow),
          };

          // While a session pipeline/QR runs: enqueue only — do not clobber phase.
          if (isSdPipelineBusy()) {
            enqueueSdJob({
              drive: payload.drive,
              kind,
              actions: kind === "auto" ? actionsSafe : undefined,
              payload,
              enqueuedAt: Date.now(),
            });
            showSdQueuedToast(payload.drive);
            return;
          }

          setActiveDrive(payload.drive);
          setPhase(payload.needs_confirmation ? "confirming" : "detected");

          if (kind === "size_limit") {
            onRequestSelectRef.current?.(payload.drive, "size_limit");
            return;
          }
          if (kind === "confirm") {
            onRequestSelectRef.current?.(payload.drive, "backup");
            return;
          }

          if (actionsSafe.backup || actionsSafe.import) {
            onAutoProcessRef.current?.(payload.drive, actionsSafe);
          }
        }),
      );

      unlisteners.push(
        await listen<{ drives: string[] }>("sd-card-removed", (event) => {
          const removed = event.payload.drives ?? [];
          const st = useSdStore.getState();
          const removedSet = new Set(removed);

          const dropped = dropQueuedDrives(removed);
          for (const job of dropped) {
            showSdQueueDroppedToast(job.drive);
          }

          if (removed.length) {
            void scanSdDrives()
              .then((list) => {
                setDrives(list);
                const cur = useSdStore.getState().activeDrive;
                if (cur && removedSet.has(cur)) {
                  setActiveDrive(list[0]?.drive ?? null);
                }
              })
              .catch(() => undefined);
          }

          const selectorGone =
            st.selectorOpen &&
            Boolean(st.selectorDrive) &&
            removedSet.has(st.selectorDrive!);

          if (selectorGone) {
            closeSelector();
            onRequestDrainRef.current?.();
          }

          const workflowMountGone =
            Boolean(st.workflowMountDrive) &&
            removedSet.has(st.workflowMountDrive!);

          // Early eject is expected — keep import/QR progress alive.
          if (st.workflowActive && workflowMountGone) {
            if (st.workflowMountReleased) {
              if (dropped.length) onRequestDrainRef.current?.();
              return;
            }
            setBackupProgress(null);
            setWorkflowProgress(null);
            setPhase("monitoring");
            setPendingInsert(null);
            return;
          }

          // Idle (or busy on another drive): don't wipe progress of an active job.
          if (!st.workflowActive && !st.selectorOpen) {
            setPhase("monitoring");
            setPendingInsert(null);
            setBackupProgress(null);
            setWorkflowProgress(null);
            if (dropped.length) onRequestDrainRef.current?.();
            return;
          }

          if (dropped.length) onRequestDrainRef.current?.();
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
          if (kind === "mtp_catalog") {
            queueCatalog(
              event.payload.data as {
                drive?: string;
                files?: SdFileInfo[];
                total_size_mb?: number;
                done?: boolean;
              } | null,
            );
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
      if (catalogTimer != null) window.clearTimeout(catalogTimer);
      for (const u of unlisteners) u();
    };
  }, [
    closeSelector,
    dropQueuedDrives,
    enqueueSdJob,
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
