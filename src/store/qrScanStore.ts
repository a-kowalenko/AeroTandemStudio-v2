import { create } from "zustand";

export type QrScanPhase = "pending" | "active" | "done" | "hit";

type QrScanState = {
  busy: boolean;
  /** Normalized path → phase for the current scan job. */
  byPath: Record<string, QrScanPhase>;
  begin: (paths: string[]) => void;
  setPhase: (path: string, phase: QrScanPhase) => void;
  end: () => void;
  phaseFor: (path: string) => QrScanPhase | null;
};

export function normalizeMediaPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export const useQrScanStore = create<QrScanState>((set, get) => ({
  busy: false,
  byPath: {},

  begin: (paths) => {
    const byPath: Record<string, QrScanPhase> = {};
    for (const p of paths) {
      if (!p.trim()) continue;
      byPath[normalizeMediaPath(p)] = "pending";
    }
    set({ busy: true, byPath });
  },

  setPhase: (path, phase) => {
    const key = normalizeMediaPath(path);
    if (!get().byPath[key] && !get().busy) return;
    set({
      byPath: { ...get().byPath, [key]: phase },
    });
  },

  end: () => set({ busy: false, byPath: {} }),

  phaseFor: (path) => get().byPath[normalizeMediaPath(path)] ?? null,
}));

/** Run an async QR scan while tracking the given paths in the grid UI. */
export async function withQrScanProgress<T>(
  paths: string[],
  run: () => Promise<T>,
): Promise<T> {
  const store = useQrScanStore.getState();
  store.begin(paths);
  try {
    return await run();
  } finally {
    store.end();
  }
}
