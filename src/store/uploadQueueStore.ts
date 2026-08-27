import { create } from "zustand";
import {
  cancelActiveUploadJob,
  clearActiveUploadJob,
  clearQueuedUploadJobs,
  createEmptyUploadQueue,
  enqueueUploadJob,
  promoteNextUploadJob,
  uploadQueueHasWork,
  uploadQueueWorkCount,
  type UploadQueueJob,
  type UploadQueueSnapshot,
  type UploadSlotResult,
} from "@/lib/uploadQueue";

/** Panel phase while the active slot job is cancelling / cleaning remote. */
export type UploadCancelPhase = "cancelling" | "cleanup" | null;

type UploadQueueState = UploadQueueSnapshot & {
  /** Outcome of the most recently finished slot job (for fail hold UI). */
  lastOutcome: UploadSlotResult | null;
  /** UI: Wird abgebrochen… → Aufräumen… while slot stays occupied. */
  cancelPhase: UploadCancelPhase;
  enqueue: (job: UploadQueueJob) => void;
  /** Promote next if idle; returns the new active job (or null). */
  promoteNext: () => UploadQueueJob | null;
  clearActive: () => void;
  /** Clear active only (queue kept). Returns cancelled job if any. */
  cancelActive: () => UploadQueueJob | null;
  /** Drop waiting jobs; returns cleared list. Active unchanged. */
  clearQueued: () => UploadQueueJob[];
  setLastOutcome: (outcome: UploadSlotResult | null) => void;
  setCancelPhase: (phase: UploadCancelPhase) => void;
  workCount: () => number;
  hasWork: () => boolean;
  reset: () => void;
};

export const useUploadQueueStore = create<UploadQueueState>((set, get) => ({
  ...createEmptyUploadQueue(),
  lastOutcome: null,
  cancelPhase: null,

  enqueue: (job) => {
    set((s) => ({
      ...enqueueUploadJob({ active: s.active, queue: s.queue }, job),
      lastOutcome: null,
    }));
  },

  promoteNext: () => {
    let promoted: UploadQueueJob | null = null;
    set((s) => {
      // Never re-return an already-running job (drain would double-run).
      if (s.active !== null) return s;
      const next = promoteNextUploadJob({ active: s.active, queue: s.queue });
      promoted = next.active;
      return { ...next, cancelPhase: null };
    });
    return promoted;
  },

  clearActive: () => {
    set((s) => clearActiveUploadJob({ active: s.active, queue: s.queue }));
  },

  cancelActive: () => {
    let cancelled: UploadQueueJob | null = null;
    set((s) => {
      const result = cancelActiveUploadJob({
        active: s.active,
        queue: s.queue,
      });
      cancelled = result.cancelled;
      return result.state;
    });
    return cancelled;
  },

  clearQueued: () => {
    let cleared: UploadQueueJob[] = [];
    set((s) => {
      const result = clearQueuedUploadJobs({
        active: s.active,
        queue: s.queue,
      });
      cleared = result.cleared;
      return result.state;
    });
    return cleared;
  },

  setLastOutcome: (outcome) => set({ lastOutcome: outcome }),

  setCancelPhase: (phase) => set({ cancelPhase: phase }),

  workCount: () =>
    uploadQueueWorkCount({ active: get().active, queue: get().queue }),

  hasWork: () =>
    uploadQueueHasWork({ active: get().active, queue: get().queue }),

  reset: () =>
    set({ ...createEmptyUploadQueue(), lastOutcome: null, cancelPhase: null }),
}));
