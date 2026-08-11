import { create } from "zustand";
import type {
  BackupProgress,
  SdDriveInfo,
  SdInsertedPayload,
  SecondaryBackupEvent,
  WorkflowProgress,
} from "../lib/sdCard";

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
  drives: SdDriveInfo[];
  activeDrive: string | null;
  pendingInsert: SdInsertedPayload | null;
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
  setActiveDrive: (drive: string | null) => void;
  setPendingInsert: (payload: SdInsertedPayload | null) => void;
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

export const useSdStore = create<SdState>((set) => ({
  monitoring: false,
  phase: "idle",
  workflowActive: false,
  drives: [],
  activeDrive: null,
  pendingInsert: null,
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
  setActiveDrive: (activeDrive) => set({ activeDrive }),
  setPendingInsert: (pendingInsert) => set({ pendingInsert }),
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
