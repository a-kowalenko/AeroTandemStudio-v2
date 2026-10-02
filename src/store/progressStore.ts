import { create } from "zustand";
import { tr } from "@/i18n";
import type { EncodeProgress, TaskProgressState } from "../components/app/types";
import type { CreateJobPlan } from "../lib/createJobPlan";
import {
  applyMonotonicPercent,
  formatOverallProgressLabel,
  resolveProgressLabel,
  shouldClearTaskProgress,
  shouldResetOverallProgressPercent,
} from "../lib/progressLabels";

/**
 * Session encode progress (OPT-24 E). Lives outside `App` so high-frequency
 * `encode-progress` events only re-render the progress consumers.
 */
type ProgressState = {
  percent: number;
  status: string;
  taskProgress: TaskProgressState[];
  createJobPlan: CreateJobPlan | null;
  setPercent: (percent: number) => void;
  setStatus: (status: string) => void;
  setTaskProgress: (tasks: TaskProgressState[]) => void;
  setCreateJobPlan: (plan: CreateJobPlan | null) => void;
  reset: () => void;
  applyEncodeProgress: (p: EncodeProgress) => void;
};

export const useProgressStore = create<ProgressState>((set) => ({
  percent: 0,
  status: "",
  taskProgress: [],
  createJobPlan: null,

  setPercent: (percent) => set({ percent }),
  setStatus: (status) => set({ status }),
  setTaskProgress: (taskProgress) => set({ taskProgress }),
  setCreateJobPlan: (createJobPlan) => set({ createJobPlan }),
  reset: () => set({ percent: 0, status: "", taskProgress: [], createJobPlan: null }),

  applyEncodeProgress: (p) =>
    set((s) => {
      if (p.task_id != null && p.task_id > 0) {
        // Per-clip bars only — overall % comes exclusively from overall events
        // (avoids flicker when task-average and remapped stage % race).
        const next = [...s.taskProgress];
        const idx = next.findIndex((t) => t.taskId === p.task_id);
        const prevStatus = idx >= 0 ? next[idx].status : "";
        const entry: TaskProgressState = {
          taskId: p.task_id,
          percent: applyMonotonicPercent(idx >= 0 ? next[idx].percent : 0, p.percent),
          status: resolveProgressLabel(p.status, prevStatus),
        };
        if (idx >= 0) next[idx] = entry;
        else next.push(entry);
        next.sort((a, b) => a.taskId - b.taskId);

        const prev = s.status;
        const keepStatus =
          prev &&
          !/^(continue|end|starting|in arbeit…)$/i.test(prev.trim()) &&
          prev !== tr("common.status.inProgress");
        return {
          taskProgress: next,
          status: keepStatus ? prev : formatOverallProgressLabel(p.status, prev),
        };
      }

      const percent = shouldResetOverallProgressPercent(p.status)
        ? Math.max(0, Math.min(100, p.percent))
        : applyMonotonicPercent(s.percent, p.percent);
      const label = resolveProgressLabel(p.status, undefined);
      const status = formatOverallProgressLabel(p.status, s.status);
      const clearTasks = shouldClearTaskProgress(p.status) || shouldClearTaskProgress(label);
      return clearTasks ? { percent, status, taskProgress: [] } : { percent, status };
    }),
}));
