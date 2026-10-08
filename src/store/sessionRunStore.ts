import { create } from "zustand";
import {
  buildSessionRunOutcome,
  type SessionRunOutcome,
} from "@/lib/sessionRunOutcome";
import type { QrPreview } from "@/lib/tauri";
import type { DialogActionStatus } from "@/store/uiStore";

type PresentSessionRunOpts = {
  title: string;
  highlight?: string;
  actions: DialogActionStatus[];
  queuedNext?: boolean;
  qrPreview?: QrPreview | null;
  hold?: boolean;
  /** Keep the current card id so SessionOutcomeCard updates in place. */
  keepId?: boolean;
};

type SessionRunState = {
  outcome: SessionRunOutcome | null;
  presentSessionRun: (opts: PresentSessionRunOpts) => void;
  clearSessionRun: () => void;
};

export const useSessionRunStore = create<SessionRunState>((set) => ({
  outcome: null,
  presentSessionRun: (opts) =>
    set((state) => ({
      outcome: buildSessionRunOutcome({
        ...opts,
        id:
          opts.keepId && state.outcome != null
            ? state.outcome.id
            : undefined,
      }),
    })),
  clearSessionRun: () => set({ outcome: null }),
}));
