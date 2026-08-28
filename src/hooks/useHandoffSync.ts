import { useEffect, useRef } from "react";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import {
  applyAppendStatusToEntry,
  applyHandoffToEntry,
} from "@/lib/amsHandoffPatch";
import {
  AMS_HANDOFF_POLL_BATCH,
  collectHandoffSyncTargets,
  nextHandoffPollBatch,
} from "@/lib/amsHandoffPoll";
import {
  getHandoffStatus,
  listVorgaenge,
  refreshPendingUploadCount,
  syncOpenHandoffs,
} from "@/lib/vorgangHistory";
import { useConfigStore } from "@/store/configStore";
import { useHistoryStore } from "@/store/historyStore";

function canSyncHandoff(config: {
  upload_to_server?: boolean;
  server_url?: string | null;
  ams_bridge_url?: string | null;
  ams_bridge_last_ok_url?: string | null;
} | null): boolean {
  if (!config?.upload_to_server) return false;
  const smb = Boolean((config.server_url ?? "").trim());
  const bridge = isAmsBridgeConfigured(config);
  return smb || bridge;
}

function collectSyncTargets() {
  const store = useHistoryStore.getState();
  const rows = store.vorgaenge;
  const folderMissingById = store.folderMissingById;
  return collectHandoffSyncTargets(rows, folderMissingById);
}

async function runHandoffSyncBatch(
  maxJobs: number,
  cursorRef: { current: number },
): Promise<number> {
  let rows = useHistoryStore.getState().vorgaenge;
  if (!useHistoryStore.getState().vorgaengeLoaded) {
    rows = await listVorgaenge(500);
    useHistoryStore.getState().setVorgaenge(rows);
  }

  const targets = collectSyncTargets();
  if (targets.length === 0) return 0;

  const batchSize = Math.min(maxJobs, AMS_HANDOFF_POLL_BATCH);
  const { batch, nextCursor } = nextHandoffPollBatch(
    targets,
    cursorRef.current,
    batchSize,
  );
  cursorRef.current = nextCursor;

  let patched = 0;
  for (const target of batch) {
    try {
      const status = await getHandoffStatus(
        target.correlationId,
        target.baseOutputDir,
        target.vorgangId,
      );
      if (!status) continue;
      useHistoryStore.getState().patchVorgang(target.vorgangId, (row) =>
        target.kind === "append"
          ? applyAppendStatusToEntry(row, status)
          : applyHandoffToEntry(row, status),
      );
      patched += 1;
    } catch {
      /* keep cached SQLite fields */
    }
  }
  return patched;
}

/**
 * Boot + dialog-open: eagerly sync unsettled AMS handoffs (incl. post-upload / no local folder).
 */
export function useHandoffSync(enabled: boolean, opts?: { eager?: boolean }) {
  const config = useConfigStore((s) => s.config);
  const syncEnabled = enabled && canSyncHandoff(config);
  const cursorRef = useRef(0);
  const eager = opts?.eager ?? true;

  useEffect(() => {
    if (!syncEnabled || !eager) return;
    cursorRef.current = 0;
    void (async () => {
      try {
        const updated = await syncOpenHandoffs(500);
        if (updated > 0) {
          const rows = await listVorgaenge(500);
          useHistoryStore.getState().setVorgaenge(rows);
          void refreshPendingUploadCount(
            Boolean(useConfigStore.getState().config?.upload_to_server),
          ).catch(() => {});
        }
      } catch {
        /* keep cached SQLite fields */
      }
    })();
  }, [syncEnabled, eager]);

  return {
    syncNow: (maxJobs = AMS_HANDOFF_POLL_BATCH) =>
      runHandoffSyncBatch(maxJobs, cursorRef),
  };
}

export { runHandoffSyncBatch, collectSyncTargets };
