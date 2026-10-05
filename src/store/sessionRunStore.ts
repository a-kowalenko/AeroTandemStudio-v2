import { create } from "zustand";
import {
  buildSessionRunOutcome,
  type SessionRunOutcome,
} from "@/lib/sessionRunOutcome";
import type { QrPreview } from "@/lib/tauri";
import type { DialogActionStatus } from "@/store/uiStore";

type SessionRunState = {
  outcome: SessionRunOutcome | null;
  presentSessionRun: (opts: {
    title: string;
    highlight?: string;
    actions: DialogActionStatus[];
    queuedNext?: boolean;
    qrPreview?: QrPreview | null;
  }) => void;
  clearSessionRun: () => void;
};

export const useSessionRunStore = create<SessionRunState>((set) => ({
  outcome: null,
  presentSessionRun: (opts) => set({ outcome: buildSessionRunOutcome(opts) }),
  clearSessionRun: () => set({ outcome: null }),
}));
