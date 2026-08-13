import { create } from "zustand";
import type {
  BackupProgress,
  SdDriveInfo,
  SdInsertedPayload,
  SecondaryBackupEvent,
  WorkflowProgress,
} from "../lib/sdCard";
import {
  dropDrivesFromQueue,
  keepOnlyMountedDrives,
  mergeSdQueue,
  SD_QUEUE_MAX,
  type QueuedSdJob,
} from "../lib/sdQueue";
import { useQrScanStore } from "./qrScanStore";

type SdPhase =
  | "idle"
  | "monitoring"
  | "detected"
  | "confirming"
  | "backing_up"
  | "clearing"
  | "importing";

type SdState = {
  monitoring: boolean;
  phase: SdPhase;
  /** True only while `runSdWorkflow` is in flight — gates shared progress events. */
  workflowActive: boolean;
  /**
   * Listing / pre-workflow gate so inserts during `listSdFiles` enqueue
   * instead of starting a parallel pipeline.
   */
  intakeBusy: boolean;
  /**
   * Drive the in-flight `runSdWorkflow` was started for.
   * Used so early eject / a queued 2nd card doesn't wipe QR/import progress.
   */
  workflowMountDrive: string | null;
  /** True after the workflow mount was ejected (further work uses backup copies). */
  workflowMountReleased: boolean;
  drives: SdDriveInfo[];
  activeDrive: string | null;
  pendingInsert: SdInsertedPayload | null;
  /** FIFO of SD jobs waiting for the current session pipeline. */
  jobQueue: QueuedSdJob[];
  backupProgress: BackupProgress | null;
  workflowProgress: WorkflowProgress | null;
  /** Background mirror to second backup path (non-blocking). */
  secondaryBackup: SecondaryBackupEvent | null;
  selectorOpen: boolean;
  selectorDrive: string | null;
  selectorFiles: import("../lib/sdCard").SdFileInfo[];
  selectorTotalMb: number;
  selectorMode: "backup" | "import" | "size_limit";
  processedOpen: boolean;
  setMonitoring: (v: boolean) => void;
  setDrives: (drives: SdDriveInfo[]) => void;
  setPhase: (phase: SdPhase) => void;
  setWorkflowActive: (active: boolean) => void;
  setIntakeBusy: (busy: boolean) => void;
  beginWorkflowMount: (drive: string) => void;
  markWorkflowMountReleased: () => void;
  clearWorkflowMount: () => void;
  setActiveDrive: (drive: string | null) => void;
  setPendingInsert: (payload: SdInsertedPayload | null) => void;
  enqueueSdJob: (job: QueuedSdJob) => void;
  prependSdJob: (job: QueuedSdJob) => void;
  shiftSdJob: () => QueuedSdJob | null;
  dropQueuedDrives: (drives: string[]) => QueuedSdJob[];
  pruneQueueToMounted: (mountedDrives: string[]) => QueuedSdJob[];
  clearSdQueue: () => void;
  setBackupProgress: (p: BackupProgress | null) => void;
  setWorkflowProgress: (p: WorkflowProgress | null) => void;
  setSecondaryBackup: (p: SecondaryBackupEvent | null) => void;
  openSelector: (opts: {
    drive: string;
    files: import("../lib/sdCard").SdFileInfo[];
    totalMb: number;
    mode: "backup" | "import" | "size_limit";
  }) => void;
  patchSelectorFiles: (
    updates: Array<{
      path: string;
      display_epoch: number;
      already_processed: boolean;
    }>,
  ) => void;
  closeSelector: () => void;
  setProcessedOpen: (open: boolean) => void;
};

/** True while listing, selector, workflow, or QR should defer new SD starts. */
export function isSdPipelineBusy(state = useSdStore.getState()): boolean {
  return (
    state.workflowActive ||
    state.selectorOpen ||
    state.intakeBusy ||
    useQrScanStore.getState().busy
  );
}

export const useSdStore = create<SdState>((set, get) => ({
  monitoring: false,
  phase: "idle",
  workflowActive: false,
  intakeBusy: false,
  workflowMountDrive: null,
  workflowMountReleased: false,
  drives: [],
  activeDrive: null,
  pendingInsert: null,
  jobQueue: [],
  backupProgress: null,
  workflowProgress: null,
  secondaryBackup: null,
  selectorOpen: false,
  selectorDrive: null,
  selectorFiles: [],
  selectorTotalMb: 0,
  selectorMode: "import",
  processedOpen: false,

  setMonitoring: (monitoring) =>
    set({ monitoring, phase: monitoring ? "monitoring" : "idle" }),
  setDrives: (drives) => set({ drives }),
  setPhase: (phase) => set({ phase }),
  setWorkflowActive: (workflowActive) => set({ workflowActive }),
  setIntakeBusy: (intakeBusy) => set({ intakeBusy }),
  beginWorkflowMount: (drive) =>
    set({
      workflowMountDrive: drive,
      workflowMountReleased: false,
    }),
  markWorkflowMountReleased: () => set({ workflowMountReleased: true }),
  clearWorkflowMount: () =>
    set({ workflowMountDrive: null, workflowMountReleased: false }),
  setActiveDrive: (activeDrive) => set({ activeDrive }),
  setPendingInsert: (pendingInsert) => set({ pendingInsert }),
  enqueueSdJob: (job) =>
    set((s) => ({ jobQueue: mergeSdQueue(s.jobQueue, job) })),
  prependSdJob: (job) =>
    set((s) => {
      const rest = s.jobQueue.filter((j) => j.drive !== job.drive);
      return { jobQueue: [job, ...rest].slice(0, SD_QUEUE_MAX) };
    }),
  shiftSdJob: () => {
    const [first, ...rest] = get().jobQueue;
    if (!first) return null;
    set({ jobQueue: rest });
    return first;
  },
  dropQueuedDrives: (drives) => {
    const { queue, dropped } = dropDrivesFromQueue(get().jobQueue, drives);
    if (dropped.length) set({ jobQueue: queue });
    return dropped;
  },
  pruneQueueToMounted: (mountedDrives) => {
    const { queue, dropped } = keepOnlyMountedDrives(
      get().jobQueue,
      mountedDrives,
    );
    if (dropped.length) set({ jobQueue: queue });
    return dropped;
  },
  clearSdQueue: () => set({ jobQueue: [] }),
  setBackupProgress: (backupProgress) => set({ backupProgress }),
  setWorkflowProgress: (workflowProgress) => set({ workflowProgress }),
  setSecondaryBackup: (secondaryBackup) => set({ secondaryBackup }),
  openSelector: ({ drive, files, totalMb, mode }) =>
    set({
      selectorOpen: true,
      selectorDrive: drive,
      selectorFiles: files,
      selectorTotalMb: totalMb,
      selectorMode: mode,
    }),
  patchSelectorFiles: (updates) =>
    set((state) => {
      if (!updates.length || !state.selectorOpen) return state;
      const map = new Map(updates.map((u) => [u.path, u]));
      let changed = false;
      const selectorFiles = state.selectorFiles.map((f) => {
        const u = map.get(f.path);
        if (!u) return f;
        if (
          f.display_epoch === u.display_epoch &&
          f.already_processed === u.already_processed
        ) {
          return f;
        }
        changed = true;
        return {
          ...f,
          display_epoch: u.display_epoch,
          already_processed: u.already_processed,
        };
      });
      return changed ? { selectorFiles } : state;
    }),
  closeSelector: () =>
    set({
      selectorOpen: false,
      selectorDrive: null,
      selectorFiles: [],
      selectorTotalMb: 0,
    }),
  setProcessedOpen: (processedOpen) => set({ processedOpen }),
}));
