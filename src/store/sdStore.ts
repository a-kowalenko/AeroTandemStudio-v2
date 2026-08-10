import { create } from "zustand";
import type {
  BackupProgress,
  SdDriveInfo,
  SdInsertedPayload,
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
  drives: SdDriveInfo[];
  activeDrive: string | null;
  pendingInsert: SdInsertedPayload | null;
  backupProgress: BackupProgress | null;
  workflowProgress: WorkflowProgress | null;
  selectorOpen: boolean;
  selectorDrive: string | null;
  selectorFiles: import("../lib/sdCard").SdFileInfo[];
  selectorTotalMb: number;
  selectorMode: "backup" | "import" | "size_limit";
  processedOpen: boolean;
  setMonitoring: (v: boolean) => void;
  setDrives: (drives: SdDriveInfo[]) => void;
  setPhase: (phase: SdPhase) => void;
  setActiveDrive: (drive: string | null) => void;
  setPendingInsert: (payload: SdInsertedPayload | null) => void;
  setBackupProgress: (p: BackupProgress | null) => void;
  setWorkflowProgress: (p: WorkflowProgress | null) => void;
  openSelector: (opts: {
    drive: string;
    files: import("../lib/sdCard").SdFileInfo[];
    totalMb: number;
    mode: "backup" | "import" | "size_limit";
  }) => void;
  closeSelector: () => void;
  setProcessedOpen: (open: boolean) => void;
};

export const useSdStore = create<SdState>((set) => ({
  monitoring: false,
  phase: "idle",
  drives: [],
  activeDrive: null,
  pendingInsert: null,
  backupProgress: null,
  workflowProgress: null,
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
  setActiveDrive: (activeDrive) => set({ activeDrive }),
  setPendingInsert: (pendingInsert) => set({ pendingInsert }),
  setBackupProgress: (backupProgress) => set({ backupProgress }),
  setWorkflowProgress: (workflowProgress) => set({ workflowProgress }),
  openSelector: ({ drive, files, totalMb, mode }) =>
    set({
      selectorOpen: true,
      selectorDrive: drive,
      selectorFiles: files,
      selectorTotalMb: totalMb,
      selectorMode: mode,
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
