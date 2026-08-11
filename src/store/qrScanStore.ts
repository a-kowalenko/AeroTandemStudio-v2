import { create } from "zustand";

export type QrScanPhase = "pending" | "active" | "done" | "hit";

/** High-level job stage for status text (confirm dialog / overlay). */
export type QrScanJobStage =
  | "idle"
  | "scanning"
  | "scanning_videos"
  | "scanning_photos"
  | "followup";

export type QrFollowupStatus = {
  /** Path currently being decoded (or last completed). */
  currentPath: string | null;
  /** `start` | `hit` | `miss` */
  phase: "start" | "hit" | "miss" | null;
  /** Completed follow-up scans. */
  scanned: number;
  /** Extra QR carriers found (excluding the original hit). */
  extraHits: number;
};

type QrScanState = {
  busy: boolean;
  stage: QrScanJobStage;
  /** Normalized path → phase for the current scan job. */
  byPath: Record<string, QrScanPhase>;
  followup: QrFollowupStatus | null;
  begin: (paths: string[], stage?: QrScanJobStage) => void;
  setStage: (stage: QrScanJobStage) => void;
  setPhase: (path: string, phase: QrScanPhase) => void;
  setFollowup: (status: QrFollowupStatus) => void;
  end: () => void;
  phaseFor: (path: string) => QrScanPhase | null;
};

export function normalizeMediaPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function fileBaseName(path: string): string {
  return path.replace(/^.*[/\\]/, "");
}

const emptyFollowup = (): QrFollowupStatus => ({
  currentPath: null,
  phase: null,
  scanned: 0,
  extraHits: 0,
});

/** Human-readable progress for SD confirm dialog / loading UI. */
export function summarizeQrScanProgress(
  byPath: Record<string, QrScanPhase>,
  stage: QrScanJobStage,
  followup: QrFollowupStatus | null = null,
): {
  label: string;
  detail: string;
  percent: number;
  indeterminate: boolean;
} {
  if (stage === "followup") {
    const fu = followup ?? emptyFollowup();
    const parts: string[] = [];
    if (fu.scanned > 0) {
      parts.push(`${fu.scanned} geprüft`);
    }
    parts.push(
      fu.extraHits === 1
        ? "1 weiterer Treffer"
        : `${fu.extraHits} weitere Treffer`,
    );
    if (fu.currentPath) {
      const name = fileBaseName(fu.currentPath);
      if (fu.phase === "start") {
        parts.push(`prüft ${name}`);
      } else if (fu.phase === "hit") {
        parts.push(`Treffer: ${name}`);
      } else if (fu.phase === "miss") {
        parts.push(`kein QR: ${name}`);
      } else {
        parts.push(name);
      }
    } else {
      parts.push("Serie erweitern…");
    }
    return {
      label: "QR gefunden — Nachbarfotos prüfen…",
      detail: parts.join(" · "),
      percent: 100,
      indeterminate: true,
    };
  }

  const entries = Object.entries(byPath);
  const total = entries.length;
  const finished = entries.filter(
    ([, p]) => p === "done" || p === "hit",
  ).length;
  const active = entries.find(([, p]) => p === "active");
  const hit = entries.find(([, p]) => p === "hit");

  const label =
    stage === "scanning_videos"
      ? "QR-Scan: Videos…"
      : stage === "scanning_photos"
        ? "QR-Scan: Fotos…"
        : "QR-Scan…";

  const parts: string[] = [];
  if (total > 0) {
    parts.push(`${finished}/${total} geprüft`);
  }
  if (hit) {
    parts.push(`Treffer: ${fileBaseName(hit[0])}`);
  } else if (active) {
    parts.push(fileBaseName(active[0]));
  } else if (total > 0 && finished === 0) {
    parts.push("Worker starten…");
  }

  const percent =
    total > 0 ? Math.min(100, Math.round((finished / total) * 100)) : 0;

  return {
    label,
    detail: parts.join(" · "),
    percent,
    indeterminate: total === 0 || (finished === 0 && !active),
  };
}

export const useQrScanStore = create<QrScanState>((set, get) => ({
  busy: false,
  stage: "idle",
  byPath: {},
  followup: null,

  begin: (paths, stage = "scanning") => {
    const byPath: Record<string, QrScanPhase> = {};
    for (const p of paths) {
      if (!p.trim()) continue;
      byPath[normalizeMediaPath(p)] = "pending";
    }
    set({
      busy: true,
      stage,
      byPath,
      followup: stage === "followup" ? emptyFollowup() : null,
    });
  },

  setStage: (stage) => {
    const followup = stage === "followup" ? emptyFollowup() : get().followup;
    if (!get().busy && stage !== "idle") {
      set({ busy: true, stage, followup });
      return;
    }
    set({
      stage,
      followup: stage === "followup" ? emptyFollowup() : followup,
    });
  },

  setPhase: (path, phase) => {
    const key = normalizeMediaPath(path);
    if (!get().byPath[key] && !get().busy) return;
    set({
      byPath: { ...get().byPath, [key]: phase },
    });
  },

  setFollowup: (status) => {
    set({
      stage: "followup",
      busy: true,
      followup: status,
    });
  },

  end: () =>
    set({ busy: false, stage: "idle", byPath: {}, followup: null }),

  phaseFor: (path) => get().byPath[normalizeMediaPath(path)] ?? null,
}));

/** Run an async QR scan while tracking the given paths in the grid UI. */
export async function withQrScanProgress<T>(
  paths: string[],
  run: () => Promise<T>,
  stage: QrScanJobStage = "scanning",
): Promise<T> {
  const store = useQrScanStore.getState();
  store.begin(paths, stage);
  try {
    return await run();
  } finally {
    store.end();
  }
}
