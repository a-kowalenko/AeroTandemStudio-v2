/** In-memory FIFO upload slot helpers (Phase 37.1). */

export type UploadJobSource = "create" | "history" | "bulk" | "append";

export type UploadSlotResult = "ok" | "failed" | "cancelled";

export type UploadQueueJob = {
  id: string;
  source: UploadJobSource;
  localDir: string;
  folderName: string | null;
  correlationId: string | null;
  vorgangId: number | null;
  /** Optional guest / folder label for toasts. */
  guestLabel?: string | null;
  /** Snapshotted at enqueue for queue UI (Compact-Bar). */
  tandemmaster?: string | null;
  /** Snapshotted at enqueue for queue UI (Compact-Bar). */
  videospringer?: string | null;
  /** Suppress success toast (bulk quiet phase). */
  quietSuccess?: boolean;
};

/** Waiting-job row for Compact-Bar queue collapsible. */
export type UploadQueueJobPreview = {
  id: string;
  guestLabel: string | null;
  folderName: string | null;
  tandemmaster: string | null;
  videospringer: string | null;
};

export function toUploadQueueJobPreview(
  job: UploadQueueJob,
): UploadQueueJobPreview {
  return {
    id: job.id,
    guestLabel: job.guestLabel?.trim() || null,
    folderName: job.folderName?.trim() || null,
    tandemmaster: job.tandemmaster?.trim() || null,
    videospringer: job.videospringer?.trim() || null,
  };
}

type UploadJobLineTranslate = (
  key: string,
  options?: { name?: string },
) => string;

/** Guest (+ optional TA/V) line for Compact-Bar active subtitle and queue rows. */
export function formatUploadJobLine(
  job: Pick<
    UploadQueueJobPreview,
    "guestLabel" | "folderName" | "tandemmaster" | "videospringer"
  >,
  t: UploadJobLineTranslate,
  untitledKey = "workflow.upload.queueUntitled",
): string {
  const guest =
    job.guestLabel?.trim() || job.folderName?.trim() || t(untitledKey);
  const crew: string[] = [];
  if (job.tandemmaster) {
    crew.push(t("history.ta", { name: job.tandemmaster }));
  }
  if (job.videospringer) {
    crew.push(t("history.vs", { name: job.videospringer }));
  }
  return crew.length > 0 ? `${guest} — ${crew.join(" · ")}` : guest;
}

export type UploadQueueSnapshot = {
  active: UploadQueueJob | null;
  queue: UploadQueueJob[];
};

export function createEmptyUploadQueue(): UploadQueueSnapshot {
  return { active: null, queue: [] };
}

export function enqueueUploadJob(
  state: UploadQueueSnapshot,
  job: UploadQueueJob,
): UploadQueueSnapshot {
  return { active: state.active, queue: [...state.queue, job] };
}

/**
 * If the slot is idle, promote the next queued job to `active`.
 * Returns the same snapshot when already running or queue empty.
 */
export function promoteNextUploadJob(
  state: UploadQueueSnapshot,
): UploadQueueSnapshot {
  if (state.active !== null) return state;
  if (state.queue.length === 0) return state;
  const [next, ...rest] = state.queue;
  return { active: next ?? null, queue: rest };
}

/** Clear the active job after done / fail / cancel (queue unchanged). */
export function clearActiveUploadJob(
  state: UploadQueueSnapshot,
): UploadQueueSnapshot {
  return { active: null, queue: state.queue };
}

/**
 * Drop the active job without touching the queue.
 * Caller cancels the SMB transfer; `promoteNext` starts the following item.
 */
export function cancelActiveUploadJob(state: UploadQueueSnapshot): {
  state: UploadQueueSnapshot;
  cancelled: UploadQueueJob | null;
} {
  if (state.active === null) {
    return { state, cancelled: null };
  }
  return {
    state: { active: null, queue: state.queue },
    cancelled: state.active,
  };
}

/** Active + waiting count (for badges / quit checks). */
export function uploadQueueWorkCount(state: UploadQueueSnapshot): number {
  return state.queue.length + (state.active ? 1 : 0);
}

export function uploadQueueHasWork(state: UploadQueueSnapshot): boolean {
  return uploadQueueWorkCount(state) > 0;
}

/**
 * Drop every queued job (active untouched). Used before quit so drain
 * does not promote the next item after the active cancel finishes.
 */
export function clearQueuedUploadJobs(
  state: UploadQueueSnapshot,
): { state: UploadQueueSnapshot; cleared: UploadQueueJob[] } {
  if (state.queue.length === 0) {
    return { state, cleared: [] };
  }
  return {
    state: { active: state.active, queue: [] },
    cleared: state.queue,
  };
}
