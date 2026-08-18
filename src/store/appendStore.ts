import { create } from "zustand";
import { createAppendJob, type AppendMediaItem, type AppendJobResult } from "@/lib/vorgangHistory";

export type AppendJobContext = {
  vorgangId: number;
  guest: string;
  fileCount: number;
};

type AppendState = {
  active: boolean;
  /** Nachreichen-Dialog offen: OS-Drops nicht in die Haupt-Dropzone. */
  captureFileDrop: boolean;
  context: AppendJobContext | null;
  begin: (ctx: AppendJobContext) => void;
  end: () => void;
  setCaptureFileDrop: (capture: boolean) => void;
  runJob: (
    vorgangId: number,
    items: AppendMediaItem[],
    ctx: AppendJobContext,
  ) => Promise<AppendJobResult>;
};

export const useAppendStore = create<AppendState>((set, get) => ({
  active: false,
  captureFileDrop: false,
  context: null,
  begin: (ctx) => set({ active: true, context: ctx }),
  end: () => set({ active: false, context: null }),
  setCaptureFileDrop: (captureFileDrop) => set({ captureFileDrop }),
  runJob: async (vorgangId, items, ctx) => {
    get().begin(ctx);
    try {
      return await createAppendJob(vorgangId, items);
    } finally {
      get().end();
    }
  },
}));
