import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { presentAutoCleanupSummary } from "@/lib/autoCleanupMessages";
import {
  folderMissingMapFromProbe,
  probeItemsFromVorgaenge,
  probeVorgangFolders,
} from "@/lib/vorgangFolderProbe";
import { runAutoCleanup } from "@/lib/tauri";
import { useAppendStore } from "@/store/appendStore";
import { useConfigStore } from "@/store/configStore";
import { useHistoryStore } from "@/store/historyStore";
import { useSdStore } from "@/store/sdStore";
import { useUiStore } from "@/store/uiStore";
import { useUploadQueueStore } from "@/store/uploadQueueStore";

const IDLE_RETRY_MS = 60_000;
const DAILY_POLL_MS = 60 * 60_000;

type Options = {
  ready: boolean;
  splashOpen: boolean;
  setupWizardOpen: boolean;
  sessionBusy: boolean;
};

/**
 * Phase 42: run age-filtered cleanup after splash when idle,
 * at most once per local calendar day (Rust gate). Retries while busy.
 */
export function useAutoCleanupRetention({
  ready,
  splashOpen,
  setupWizardOpen,
  sessionBusy,
}: Options) {
  const { t } = useTranslation();
  const showSuccess = useUiStore((s) => s.showSuccess);
  const config = useConfigStore((s) => s.config);
  const updateLocal = useConfigStore((s) => s.updateLocal);
  const appendActive = useAppendStore((s) => s.active);
  const uploadHasWork = useUploadQueueStore(
    (s) => s.active !== null || s.queue.length > 0,
  );
  const sdBlocking = useSdStore(
    (s) =>
      s.workflowActive ||
      s.backupProgress !== null ||
      s.secondaryBackup !== null,
  );
  const inFlight = useRef(false);

  const enabled =
    Boolean(config?.auto_cleanup_jobs_enabled) ||
    Boolean(config?.auto_cleanup_backups_enabled);

  const blocked =
    sessionBusy || appendActive || uploadHasWork || sdBlocking;

  useEffect(() => {
    if (!ready || splashOpen || setupWizardOpen || !enabled) return;

    let cancelled = false;

    async function attempt() {
      if (cancelled || inFlight.current) return;
      if (blocked) return;
      const cfg = useConfigStore.getState().config;
      if (
        !cfg?.auto_cleanup_jobs_enabled &&
        !cfg?.auto_cleanup_backups_enabled
      ) {
        return;
      }
      inFlight.current = true;
      try {
        const result = await runAutoCleanup();
        if (cancelled) return;
        if (result.last_auto_cleanup_date) {
          updateLocal({
            last_auto_cleanup_date: result.last_auto_cleanup_date,
          });
        }
        const body = presentAutoCleanupSummary(result);
        if (body) {
          showSuccess(body, t("settings.system.autoCleanup.toastTitle"));
          const { vorgaenge, vorgaengeLoaded, setFolderMissingById } =
            useHistoryStore.getState();
          if (vorgaengeLoaded && vorgaenge.length > 0) {
            try {
              setFolderMissingById(
                folderMissingMapFromProbe(
                  await probeVorgangFolders(
                    probeItemsFromVorgaenge(vorgaenge),
                  ),
                ),
              );
            } catch {
              // Best-effort; Historie dialog re-probes on open.
            }
          }
        }
      } catch {
        // Silent — next idle/daily tick can retry; do not toast hard failures.
      } finally {
        inFlight.current = false;
      }
    }

    void attempt();

    const idleRetry = window.setInterval(() => {
      void attempt();
    }, IDLE_RETRY_MS);

    const dailyPoll = window.setInterval(() => {
      void attempt();
    }, DAILY_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(idleRetry);
      window.clearInterval(dailyPoll);
    };
  }, [
    ready,
    splashOpen,
    setupWizardOpen,
    enabled,
    blocked,
    sessionBusy,
    appendActive,
    uploadHasWork,
    sdBlocking,
    showSuccess,
    updateLocal,
    t,
  ]);
}
