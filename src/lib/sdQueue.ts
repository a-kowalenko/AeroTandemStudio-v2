import type { SdInsertedPayload, SdWorkflowActions } from "./sdCard";

/** Queued SD work for the current session (Auto / Confirm / size-limit). */
export type QueuedSdJobKind = "auto" | "confirm" | "size_limit";

export type QueuedSdJob = {
  drive: string;
  kind: QueuedSdJobKind;
  /** Snapshot for auto runs; confirm ignores this. */
  actions?: SdWorkflowActions;
  payload: SdInsertedPayload;
  enqueuedAt: number;
};

export const SD_QUEUE_MAX = 3;

export function jobKindFromInsert(payload: SdInsertedPayload): QueuedSdJobKind {
  if (payload.size_limit_exceeded) return "size_limit";
  if (payload.needs_confirmation) return "confirm";
  return "auto";
}

/** Upsert by drive (newest wins), append, trim to max (drop oldest). */
export function mergeSdQueue(
  queue: QueuedSdJob[],
  job: QueuedSdJob,
  max = SD_QUEUE_MAX,
): QueuedSdJob[] {
  const without = queue.filter((j) => j.drive !== job.drive);
  const next = [...without, job];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function dropDrivesFromQueue(
  queue: QueuedSdJob[],
  drives: string[],
): { queue: QueuedSdJob[]; dropped: QueuedSdJob[] } {
  if (!drives.length) return { queue, dropped: [] };
  const remove = new Set(drives);
  const dropped: QueuedSdJob[] = [];
  const kept: QueuedSdJob[] = [];
  for (const j of queue) {
    if (remove.has(j.drive)) dropped.push(j);
    else kept.push(j);
  }
  return { queue: kept, dropped };
}

export function keepOnlyMountedDrives(
  queue: QueuedSdJob[],
  mounted: string[],
): { queue: QueuedSdJob[]; dropped: QueuedSdJob[] } {
  const ok = new Set(mounted);
  const dropped: QueuedSdJob[] = [];
  const kept: QueuedSdJob[] = [];
  for (const j of queue) {
    if (ok.has(j.drive)) kept.push(j);
    else dropped.push(j);
  }
  return { queue: kept, dropped };
}
