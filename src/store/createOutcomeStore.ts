import { create } from "zustand";
import {
  buildCreateRunOutcome,
  type CreateRunOutcome,
  type CreateSuccessInfo,
} from "@/lib/createRunOutcome";

type CreateOutcomeState = {
  outcome: CreateRunOutcome | null;
  presentCreateOutcome: (info: CreateSuccessInfo) => void;
  /** Patch upload fields for the outcome bound to `jobId` (keeps id → timer). */
  patchCreateOutcomeUpload: (
    jobId: string,
    patch: Partial<CreateSuccessInfo>,
  ) => void;
  /** Clear; with `id`, only when that outcome is still current. */
  clearCreateOutcome: (id?: number) => void;
};

export const useCreateOutcomeStore = create<CreateOutcomeState>((set) => ({
  outcome: null,
  presentCreateOutcome: (info) => set({ outcome: buildCreateRunOutcome(info) }),
  patchCreateOutcomeUpload: (jobId, patch) =>
    set((s) => {
      if (!s.outcome || s.outcome.info.uploadJobId !== jobId) return s;
      return {
        outcome: { ...s.outcome, info: { ...s.outcome.info, ...patch } },
      };
    }),
  clearCreateOutcome: (id) =>
    set((s) => {
      if (id != null && s.outcome?.id !== id) return s;
      return { outcome: null };
    }),
}));
