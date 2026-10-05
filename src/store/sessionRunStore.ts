import { create } from "zustand";
import {
  buildSessionRunOutcome,
  type SessionRunOutcome,
} from "@/lib/sessionRunOutcome";
import type { DialogActionStatus } from "@/store/uiStore";

type SessionRunState = {
  outcome: SessionRunOutcome | null;
  presentSessionRun: (opts: {
    title: string;
    highlight?: string;
    actions: DialogActionStatus[];
    queuedNext?: boolean;
  }) => void;
  clearSessionRun: () => void;
};

export const useSessionRunStore = create<SessionRunState>((set) => ({
  outcome: null,
  presentSessionRun: (opts) => set({ outcome: buildSessionRunOutcome(opts) }),
  clearSessionRun: () => set({ outcome: null }),
}));
