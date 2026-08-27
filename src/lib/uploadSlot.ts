import { useUploadQueueStore } from "@/store/uploadQueueStore";
import type { UploadQueueJob, UploadSlotResult } from "@/lib/uploadQueue";

export type { UploadSlotResult };

export type UploadSlotJobInput = Omit<UploadQueueJob, "id"> & { id?: string };

export type UploadSlotRunner = {
  runJob: (job: UploadQueueJob) => Promise<UploadSlotResult>;
};

let runner: UploadSlotRunner | null = null;
let draining = false;
let exitAbort = false;
let jobSeq = 0;

const waiters = new Map<
  string,
  {
    resolve: (result: UploadSlotResult) => void;
  }
>();

function nextJobId(): string {
  jobSeq += 1;
  return `upload-${jobSeq}-${Date.now().toString(36)}`;
}

function resolveWaiter(id: string, result: UploadSlotResult): void {
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiter.resolve(result);
  waiters.delete(id);
}

/** Wire the SMB executor from App (once). Replaces any previous runner. */
export function bindUploadSlotRunner(next: UploadSlotRunner): void {
  runner = next;
}

/** Enqueue a FIFO upload; resolves when this job finishes (ok/fail/cancel). */
export function enqueueUpload(
  input: UploadSlotJobInput,
): Promise<UploadSlotResult> {
  const id = input.id?.trim() || nextJobId();
  const job: UploadQueueJob = {
    id,
    source: input.source,
    localDir: input.localDir,
    folderName: input.folderName ?? null,
    correlationId: input.correlationId ?? null,
    vorgangId: input.vorgangId ?? null,
    guestLabel: input.guestLabel ?? null,
    tandemmaster: input.tandemmaster?.trim() || null,
    videospringer: input.videospringer?.trim() || null,
    quietSuccess: input.quietSuccess,
  };

  return new Promise<UploadSlotResult>((resolve) => {
    waiters.set(id, { resolve });
    useUploadQueueStore.getState().enqueue(job);
    void drainUploadSlot();
  });
}

async function drainUploadSlot(): Promise<void> {
  if (draining) return;
  if (!runner) return;
  draining = true;
  try {
    while (!exitAbort) {
      const job = useUploadQueueStore.getState().promoteNext();
      if (!job) break;

      let result: UploadSlotResult = "failed";
      try {
        // Await full cancel + remote cleanup before promoting the next job.
        result = await runner.runJob(job);
      } catch {
        result = "failed";
      }

      if (exitAbort) {
        resolveWaiter(job.id, "cancelled");
        break;
      }

      useUploadQueueStore.getState().setLastOutcome(result);
      useUploadQueueStore.getState().clearActive();
      useUploadQueueStore.getState().setCancelPhase(null);
      resolveWaiter(job.id, result);
    }
  } finally {
    draining = false;
    // A concurrent enqueue may have raced the empty check.
    if (!exitAbort && useUploadQueueStore.getState().queue.length > 0) {
      void drainUploadSlot();
    }
  }
}

/**
 * Drop waiting jobs (not the in-flight one). Resolves their waiters as cancelled.
 */
export function cancelQueuedUploads(): void {
  const cleared = useUploadQueueStore.getState().clearQueued();
  for (const job of cleared) {
    resolveWaiter(job.id, "cancelled");
  }
}

/**
 * Quit path: drop queued jobs, resolve waiters as cancelled, stop drain
 * promotion. Caller must still cancel the in-flight SMB transfer.
 */
export function abortAllUploadsForExit(): void {
  exitAbort = true;
  cancelQueuedUploads();
  const active = useUploadQueueStore.getState().active;
  if (active) {
    resolveWaiter(active.id, "cancelled");
  }
  useUploadQueueStore.getState().reset();
  useUploadQueueStore.getState().setLastOutcome("cancelled");
}

/** Test helper: clear waiters + queue state. */
export function resetUploadSlotForTests(): void {
  draining = false;
  exitAbort = false;
  runner = null;
  waiters.clear();
  jobSeq = 0;
  useUploadQueueStore.getState().reset();
}
