import { isAmsHandoffSettled } from "@/lib/amsHandoffStatus";
import { shouldSyncAmsHandoff } from "@/lib/vorgangLifecycle";
import type { VorgangEntry } from "@/lib/vorgangHistory";

/** Background AMS handoff poll interval (parity with SMB quiet health poll). */
export const AMS_HANDOFF_POLL_MS = 45_000;

/** Max handoff status fetches per poll tick (round-robin over all open jobs). */
export const AMS_HANDOFF_POLL_BATCH = 15;

export type HandoffPollTarget = {
  vorgangId: number;
  correlationId: string;
  baseOutputDir: string;
  kind: "main" | "append";
};

export function collectUnsettledHandoffTargets(
  rows: VorgangEntry[],
): HandoffPollTarget[] {
  const targets: HandoffPollTarget[] = [];
  for (const e of rows) {
    const mainCid = e.correlation_id?.trim() ?? "";
    if (
      mainCid &&
      !isAmsHandoffSettled({
        ams_state: e.ams_state,
        ams_error_code: e.ams_error_code,
      })
    ) {
      targets.push({
        vorgangId: e.id,
        correlationId: mainCid,
        baseOutputDir: e.base_output_dir,
        kind: "main",
      });
    }
    const appendCid = e.last_append_correlation_id?.trim() ?? "";
    if (
      appendCid &&
      !isAmsHandoffSettled({
        ams_state: e.last_append_ams_state,
        ams_error_code: e.last_append_ams_error_code,
      })
    ) {
      targets.push({
        vorgangId: e.id,
        correlationId: appendCid,
        baseOutputDir:
          e.last_append_folder_path?.trim() || e.base_output_dir,
        kind: "append",
      });
    }
  }
  return targets;
}

/** Sync targets incl. completed jobs that ATS should re-verify (AMS may cancel later). */
export function collectHandoffSyncTargets(
  rows: VorgangEntry[],
  folderMissingById: Record<number, boolean>,
): HandoffPollTarget[] {
  const targets: HandoffPollTarget[] = [];
  const seen = new Set<string>();

  const push = (target: HandoffPollTarget) => {
    const key = `${target.kind}:${target.vorgangId}:${target.correlationId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const e of rows) {
    const mainCid = e.correlation_id?.trim() ?? "";
    if (mainCid && shouldSyncAmsHandoff(e, folderMissingById)) {
      push({
        vorgangId: e.id,
        correlationId: mainCid,
        baseOutputDir: e.base_output_dir,
        kind: "main",
      });
    }
    const appendCid = e.last_append_correlation_id?.trim() ?? "";
    if (appendCid) {
      const appendSettled = isAmsHandoffSettled({
        ams_state: e.last_append_ams_state,
        ams_error_code: e.last_append_ams_error_code,
      });
      if (!appendSettled) {
        push({
          vorgangId: e.id,
          correlationId: appendCid,
          baseOutputDir:
            e.last_append_folder_path?.trim() || e.base_output_dir,
          kind: "append",
        });
      }
    }
  }
  return targets;
}

export function nextHandoffPollBatch(
  targets: HandoffPollTarget[],
  cursor: number,
  batchSize: number = AMS_HANDOFF_POLL_BATCH,
): { batch: HandoffPollTarget[]; nextCursor: number } {
  if (targets.length === 0) {
    return { batch: [], nextCursor: 0 };
  }
  const size = Math.min(batchSize, targets.length);
  const batch: HandoffPollTarget[] = [];
  for (let i = 0; i < size; i += 1) {
    batch.push(targets[(cursor + i) % targets.length]!);
  }
  return { batch, nextCursor: (cursor + size) % targets.length };
}
