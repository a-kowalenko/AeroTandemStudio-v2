import { create } from "zustand";

export type QrScanPhase =
  | "pending"
  | "active"
  | "done"
  | "hit"
  /** Marked for removal after QR follow-up (stripe stays until list drop). */
  | "removed";

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

/** Intra-clip progress while a video is `active`. */
export type QrClipScanPace = "prepare" | "fast" | "thorough";

export type QrClipFrameProgress = {
  frame: number;
  framesTotal: number;
  /** prepare = reading clip; fast = Schnellprüfung; thorough = gründliche Prüfung */
  mode?: QrClipScanPace;
};

/** Color legend under QR stripes. */
export type QrScanLegend = "pace" | "followup";

type QrScanState = {
  busy: boolean;
  stage: QrScanJobStage;
  /** Normalized path → phase for the current scan job. */
  byPath: Record<string, QrScanPhase>;
  /** Paths in media-list order (stripe layout = video order). */
  scanOrder: string[];
  /** Normalized path → frame progress for active video clips. */
  clipProgress: Record<string, QrClipFrameProgress>;
  followup: QrFollowupStatus | null;
  /** True when photo stripes are only list-end candidates (N=20 per side). */
  photoEdgeLimited: boolean;
  begin: (
    paths: string[],
    stage?: QrScanJobStage,
    options?: QrScanBeginOptions,
  ) => void;
  /** Re-open stripe UI for photo neighbor follow-up (full list + original hit). */
  beginFollowup: (paths: string[], hitPath: string) => void;
  setStage: (stage: QrScanJobStage) => void;
  setPhase: (path: string, phase: QrScanPhase) => void;
  setClipProgress: (
    path: string,
    frame: number,
    framesTotal: number,
    mode?: QrClipScanPace,
  ) => void;
  clearClipProgress: (path: string) => void;
  setFollowup: (status: QrFollowupStatus) => void;
  /** Paint stripes red before photos leave the media list. */
  markRemoved: (paths: string[]) => void;
  end: () => void;
  phaseFor: (path: string) => QrScanPhase | null;
};

function dedupeNormalizedPaths(paths: string[]): string[] {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  const listOrder = cleaned.map((p) => normalizeMediaPath(p));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of listOrder) {
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function isFinishedPhase(phase: QrScanPhase): boolean {
  return phase === "done" || phase === "hit" || phase === "removed";
}

export function normalizeMediaPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Photo batch: scan at most this many files from each list end (max 40). */
export const PHOTO_QR_EDGE_SCAN_PER_SIDE = 20;

/** Head + tail paths for photo QR stripes (list order, middle omitted). */
export function photoEdgeScanPaths(paths: string[]): {
  paths: string[];
  limited: boolean;
} {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  const n = cleaned.length;
  const per = PHOTO_QR_EDGE_SCAN_PER_SIDE;
  if (n <= per * 2) {
    return { paths: cleaned, limited: false };
  }
  return {
    paths: [...cleaned.slice(0, per), ...cleaned.slice(n - per)],
    limited: true,
  };
}

export type QrScanBeginOptions = {
  photoEdgeLimited?: boolean;
};

export type QrFileSegment = {
  key: string;
  phase: QrScanPhase;
  /** prepare | fast | thorough — drives stripe color. */
  pace?: QrClipScanPace;
  /** Prüfpunkte for this clip while active. */
  frame?: number;
  framesTotal?: number;
};

export type QrFileProgress = {
  segments: QrFileSegment[];
  finished: number;
  total: number;
  active: number;
};

function buildFileProgress(
  scanOrder: string[],
  byPath: Record<string, QrScanPhase>,
  clipProgress: Record<string, QrClipFrameProgress>,
): QrFileProgress | undefined {
  if (scanOrder.length === 0) return undefined;
  const segments: QrFileSegment[] = scanOrder.map((key) => {
    const phase = byPath[key] ?? "pending";
    const cp = clipProgress[key];
    const pace =
      phase === "active" && cp?.mode
        ? cp.mode
        : phase === "active"
          ? "fast"
          : undefined;
    const showFrames =
      phase === "active" &&
      cp &&
      cp.framesTotal > 0 &&
      cp.mode !== "prepare";
    return {
      key,
      phase,
      pace,
      frame: showFrames ? cp.frame : undefined,
      framesTotal: showFrames ? cp.framesTotal : undefined,
    };
  });
  const finished = segments.filter((s) => isFinishedPhase(s.phase)).length;
  const active = segments.filter((s) => s.phase === "active").length;
  return { segments, finished, total: segments.length, active };
}

function fileBaseName(path: string): string {
  return path.replace(/^.*[/\\]/, "");
}

/** Pick one active clip's progress — never sum parallel workers (that caused 30→0 jumps). */
function pickPrimaryClipProgress(
  activePaths: string[],
  clipProgress: Record<string, QrClipFrameProgress>,
): {
  frame: number;
  framesTotal: number;
  mode: QrClipScanPace;
} | null {
  let best: {
    frame: number;
    framesTotal: number;
    mode: QrClipScanPace;
    score: number;
  } | null = null;

  for (const path of activePaths) {
    const cp = clipProgress[normalizeMediaPath(path)] ?? clipProgress[path];
    if (!cp || cp.framesTotal <= 0) continue;
    const mode: QrClipScanPace = cp.mode ?? "fast";
    const frame = Math.max(0, cp.frame);
    const framesTotal = Math.max(0, cp.framesTotal);
    // Prefer thorough > fast > prepare; then furthest along in the pass.
    const paceRank = mode === "thorough" ? 3 : mode === "fast" ? 2 : 1;
    const score = paceRank * 1_000_000 + frame * 1_000 + framesTotal;
    if (!best || score > best.score) {
      best = { frame, framesTotal, mode, score };
    }
  }
  if (!best) return null;
  return {
    frame: best.frame,
    framesTotal: best.framesTotal,
    mode: best.mode,
  };
}

const emptyFollowup = (): QrFollowupStatus => ({
  currentPath: null,
  phase: null,
  scanned: 0,
  extraHits: 0,
});

export type QrScanProgressSummary = {
  label: string;
  detail: string;
  /** Kept for API compatibility; QR UI ignores percent (early exit). */
  percent: number;
  indeterminate: boolean;
  hidePercent: true;
  metric?: string;
  metricLabel?: string;
  /** Color legend under the stripes (video pace vs follow-up removal). */
  legend?: QrScanLegend;
  fileProgress?: QrFileProgress;
};

/** Human-readable progress for SD confirm dialog / loading UI (no % — scan may stop early). */
export function summarizeQrScanProgress(
  byPath: Record<string, QrScanPhase>,
  stage: QrScanJobStage,
  followup: QrFollowupStatus | null = null,
  clipProgress: Record<string, QrClipFrameProgress> = {},
  scanOrder: string[] = [],
  photoEdgeLimited = false,
): QrScanProgressSummary {
  const entries = Object.entries(byPath);
  // Stripes follow the media list order; ends-first only affects which paths go active.
  const order = scanOrder.length > 0 ? scanOrder : entries.map(([path]) => path);
  const fileProgress = buildFileProgress(order, byPath, clipProgress);

  if (stage === "followup") {
    const fu = followup ?? emptyFollowup();
    const parts: string[] = [];
    if (fu.scanned > 0) {
      parts.push(
        fu.scanned === 1
          ? "1 Foto geprüft"
          : `${fu.scanned} Fotos geprüft`,
      );
    }
    parts.push(
      fu.extraHits === 1
        ? "1 weiterer Treffer"
        : `${fu.extraHits} weitere Treffer`,
    );
    const removedCount = entries.filter(([, p]) => p === "removed").length;
    if (removedCount > 0) {
      parts.push(
        removedCount === 1
          ? "1 Foto entfernt"
          : `${removedCount} Fotos entfernt`,
      );
    }
    if (fu.currentPath && removedCount === 0) {
      const name = fileBaseName(fu.currentPath);
      if (fu.phase === "start") {
        parts.push(`gerade: ${name}`);
      } else if (fu.phase === "hit") {
        parts.push(`gefunden: ${name}`);
      } else if (fu.phase === "miss") {
        parts.push(`ohne Code: ${name}`);
      } else {
        parts.push(name);
      }
    } else if (removedCount === 0) {
      parts.push("Nachbarfotos der Serie…");
    }
    const total = fileProgress?.total ?? order.length;
    const finished = fileProgress?.finished ?? 0;
    return {
      label:
        removedCount > 0
          ? "QR-Fotos werden aus der Liste entfernt…"
          : "QR gefunden — benachbarte Fotos prüfen…",
      detail: parts.join(" · "),
      percent: 0,
      indeterminate: true,
      hidePercent: true,
      metric: total > 0 ? `${finished}/${total}` : undefined,
      metricLabel: total > 0 ? "Fotos" : undefined,
      legend: fileProgress && fileProgress.total > 0 ? "followup" : undefined,
      fileProgress,
    };
  }

  const total = order.length > 0 ? order.length : entries.length;
  const finished = entries.filter(([, p]) => isFinishedPhase(p)).length;
  const activeEntries = entries.filter(([, p]) => p === "active");
  const activeCount = activeEntries.length;
  const hit = entries.find(([, p]) => p === "hit");
  const frames = pickPrimaryClipProgress(
    activeEntries.map(([path]) => path),
    clipProgress,
  );

  const label =
    frames?.mode === "prepare"
      ? "Video wird für die QR-Suche gelesen…"
      : frames?.mode === "thorough"
        ? "QR-Code gründlich prüfen…"
        : stage === "scanning_videos"
          ? "QR-Code in Videos suchen…"
          : stage === "scanning_photos"
            ? "QR-Code in Fotos suchen…"
            : "QR-Code suchen…";

  let metric: string | undefined;
  let metricLabel: string | undefined;
  // Prüfpunkte sitzen unter den Strichen — rechts nur Dateizähler.
  if (total > 0) {
    metric = `${finished}/${total}`;
    metricLabel =
      stage === "scanning_photos"
        ? "Fotos"
        : stage === "scanning_videos"
          ? "Videos"
          : "Dateien";
  }

  const parts: string[] = [];
  if (total > 0) {
    const unit =
      stage === "scanning_photos"
        ? "Fotos"
        : stage === "scanning_videos"
          ? "Videos"
          : "Dateien";
    parts.push(`${finished} von ${total} ${unit} erledigt`);
  }
  if (stage === "scanning_photos" && photoEdgeLimited) {
    parts.push(`Ränder (je ${PHOTO_QR_EDGE_SCAN_PER_SIDE})`);
  }
  if (hit) {
    parts.push("Treffer gefunden");
  } else if (frames?.mode === "prepare") {
    parts.push("Clip wird vorbereitet…");
  } else if (frames?.mode === "thorough") {
    parts.push("Genauere Prüfung der Stellen…");
  } else if (frames?.mode === "fast") {
    parts.push("Stellen im Clip werden geprüft…");
  } else if (activeCount > 1) {
    parts.push(`${activeCount} gleichzeitig`);
  } else if (activeCount === 1 && !frames) {
    parts.push("wird geprüft…");
  } else if (total > 0 && finished === 0 && activeCount === 0) {
    parts.push("Vorbereitung…");
  }

  return {
    label,
    detail: parts.join(" · "),
    percent: 0,
    indeterminate: true,
    hidePercent: true,
    metric,
    metricLabel,
    // Pace legend only for video scan (photos have no Schnell/Gründlich).
    legend:
      stage === "scanning_videos" && fileProgress && fileProgress.total > 0
        ? "pace"
        : undefined,
    fileProgress,
  };
}

export const useQrScanStore = create<QrScanState>((set, get) => ({
  busy: false,
  stage: "idle",
  byPath: {},
  scanOrder: [],
  clipProgress: {},
  followup: null,
  photoEdgeLimited: false,

  begin: (paths, stage = "scanning", options) => {
    const unique = dedupeNormalizedPaths(paths);
    const byPath: Record<string, QrScanPhase> = {};
    for (const key of unique) {
      byPath[key] = "pending";
    }
    set({
      busy: true,
      stage,
      byPath,
      scanOrder: unique,
      clipProgress: {},
      followup: stage === "followup" ? emptyFollowup() : null,
      photoEdgeLimited: Boolean(options?.photoEdgeLimited),
    });
  },

  beginFollowup: (paths, hitPath) => {
    const unique = dedupeNormalizedPaths(paths);
    const byPath: Record<string, QrScanPhase> = {};
    for (const key of unique) {
      byPath[key] = "pending";
    }
    const hitKey = normalizeMediaPath(hitPath);
    if (hitKey in byPath) {
      byPath[hitKey] = "hit";
    }
    set({
      busy: true,
      stage: "followup",
      byPath,
      scanOrder: unique,
      clipProgress: {},
      followup: emptyFollowup(),
      photoEdgeLimited: false,
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
    const clipProgress = { ...get().clipProgress };
    if (
      phase === "done" ||
      phase === "hit" ||
      phase === "pending" ||
      phase === "removed"
    ) {
      delete clipProgress[key];
    }
    set({
      byPath: { ...get().byPath, [key]: phase },
      clipProgress,
    });
  },

  setClipProgress: (path, frame, framesTotal, mode) => {
    const key = normalizeMediaPath(path);
    if (!get().busy && !get().byPath[key]) return;
    const total = Math.max(0, Math.floor(framesTotal));
    if (total <= 0) return;
    const nextMode: QrClipScanPace = mode ?? "fast";
    const prev = get().clipProgress[key];
    let current = Math.max(0, Math.floor(frame));
    // Same pass: never move the Prüfpunkt counter backwards.
    if (
      prev &&
      prev.mode === nextMode &&
      prev.framesTotal === total &&
      nextMode !== "prepare"
    ) {
      current = Math.max(prev.frame, current);
    }
    set({
      clipProgress: {
        ...get().clipProgress,
        [key]: {
          frame: current,
          framesTotal: total,
          mode: nextMode,
        },
      },
    });
  },

  clearClipProgress: (path) => {
    const key = normalizeMediaPath(path);
    if (!(key in get().clipProgress)) return;
    const clipProgress = { ...get().clipProgress };
    delete clipProgress[key];
    set({ clipProgress });
  },

  setFollowup: (status) => {
    set({
      stage: "followup",
      busy: true,
      followup: status,
    });
  },

  markRemoved: (paths) => {
    if (paths.length === 0) return;
    const byPath = { ...get().byPath };
    const clipProgress = { ...get().clipProgress };
    for (const path of paths) {
      const key = normalizeMediaPath(path);
      byPath[key] = "removed";
      delete clipProgress[key];
    }
    set({ byPath, clipProgress });
  },

  end: () =>
    set({
      busy: false,
      stage: "idle",
      byPath: {},
      scanOrder: [],
      clipProgress: {},
      followup: null,
      photoEdgeLimited: false,
    }),

  phaseFor: (path) => get().byPath[normalizeMediaPath(path)] ?? null,
}));

/** Run an async QR scan while tracking the given paths in the grid UI. */
export async function withQrScanProgress<T>(
  paths: string[],
  run: () => Promise<T>,
  stage: QrScanJobStage = "scanning",
  options?: QrScanBeginOptions,
): Promise<T> {
  const store = useQrScanStore.getState();
  store.begin(paths, stage, options);
  try {
    return await run();
  } finally {
    store.end();
  }
}
