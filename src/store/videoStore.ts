import { create } from "zustand";
import type { VideoMetadata } from "../lib/tauri";
import { deleteWorkingCopy, importVideos, probeVideo } from "../lib/tauri";
import { syncProductsFromMedia } from "../lib/syncProductsFromMedia";
import { isCancellationError } from "../lib/utils";

export type CutMarkKind = "trim" | "split";

export type VideoSortKey = "name" | "duration" | "size";

function normPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

type VideoListState = {
  videoList: VideoMetadata[];
  importing: boolean;
  importError: string | null;
  /** Index of clip selected for unpaid-video watermark (Preview_Video). */
  watermarkClipIndex: number | null;
  /** Active column-header sort; null after manual drag reorder. */
  listSort: { key: VideoSortKey; asc: boolean } | null;
  /** path(lower) → cut kind for UI chips */
  cutMarks: Record<string, CutMarkKind>;
  /** path(lower) → bumped when file bytes change in place (player cache bust) */
  mediaRevision: Record<string, number>;
  addVideos: (paths: string[]) => Promise<void>;
  removeVideo: (path: string) => void;
  reorderVideos: (activePath: string, overPath: string) => void;
  /** Stable reorder by column (preserves watermark by path). */
  sortVideos: (key: VideoSortKey, ascending: boolean) => void;
  replaceVideo: (oldPath: string, meta: VideoMetadata) => void;
  applySplitInList: (oldPath: string, part1: VideoMetadata, part2: VideoMetadata) => void;
  restoreAfterSplitUndo: (
    part1Path: string,
    part2Path: string,
    restored: VideoMetadata,
  ) => void;
  refreshVideo: (path: string) => Promise<void>;
  clearVideos: () => void;
  clearError: () => void;
  setWatermarkClipIndex: (index: number | null) => void;
  toggleWatermarkClip: (index: number) => void;
  ensureDefaultWatermarkClip: () => void;
  clearWatermarkSelection: () => void;
  markTrimmed: (path: string) => void;
  markSplit: (part1: string, part2: string, originalPath: string) => void;
  clearCutMarksFor: (paths: string[]) => void;
  clearAllCutMarks: () => void;
  bumpMediaRevision: (path: string) => void;
  getCutMark: (path: string) => CutMarkKind | null;
  getMediaRevision: (path: string) => number;
  hasAnyCutMarks: () => boolean;
};

function bumpRev(
  map: Record<string, number>,
  path: string,
): Record<string, number> {
  const k = normPath(path);
  return { ...map, [k]: (map[k] ?? 0) + 1 };
}

export const useVideoStore = create<VideoListState>((set, get) => ({
  videoList: [],
  importing: false,
  importError: null,
  watermarkClipIndex: null,
  listSort: null,
  cutMarks: {},
  mediaRevision: {},

  addVideos: async (paths: string[]) => {
    if (paths.length === 0) return;
    set({ importing: true, importError: null });
    try {
      const imported = await importVideos(paths);
      const existing = new Set(get().videoList.map((v) => v.path.toLowerCase()));
      const fresh = imported.filter((v) => !existing.has(v.path.toLowerCase()));
      set({
        videoList: [...get().videoList, ...fresh],
        importing: false,
        importError:
          imported.length === 0
            ? "Keine gültigen Video-Dateien gefunden"
            : fresh.length === 0 && imported.length > 0
              ? "Alle Dateien sind bereits in der Liste"
              : null,
      });
      get().ensureDefaultWatermarkClip();
      if (fresh.length > 0) {
        syncProductsFromMedia({ hasVideos: true, hasPhotos: false });
      }
    } catch (e) {
      set({ importing: false, importError: String(e) });
      if (isCancellationError(e)) throw e;
    }
  },

  removeVideo: (path: string) => {
    const list = get().videoList;
    const idx = list.findIndex((v) => v.path === path);
    const next = list.filter((v) => v.path !== path);
    let wm = get().watermarkClipIndex;
    if (wm != null) {
      if (wm === idx) wm = null;
      else if (idx >= 0 && wm > idx) wm -= 1;
    }
    const k = normPath(path);
    const { [k]: _m, ...cutMarks } = get().cutMarks;
    const { [k]: _r, ...mediaRevision } = get().mediaRevision;
    set({ videoList: next, watermarkClipIndex: wm, cutMarks, mediaRevision });
    void deleteWorkingCopy(path);
  },

  reorderVideos: (activePath: string, overPath: string) => {
    const list = [...get().videoList];
    const from = list.findIndex((v) => v.path === activePath);
    const to = list.findIndex((v) => v.path === overPath);
    if (from < 0 || to < 0 || from === to) return;
    const wmPath =
      get().watermarkClipIndex != null
        ? list[get().watermarkClipIndex!]?.path
        : null;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    const wm =
      wmPath != null ? list.findIndex((v) => v.path === wmPath) : null;
    set({
      videoList: list,
      watermarkClipIndex: wm != null && wm >= 0 ? wm : null,
      listSort: null,
    });
  },

  sortVideos: (key, ascending) => {
    const list = [...get().videoList];
    if (list.length < 2) {
      set({ listSort: { key, asc: ascending } });
      return;
    }
    const wmPath =
      get().watermarkClipIndex != null
        ? list[get().watermarkClipIndex!]?.path
        : null;
    const dir = ascending ? 1 : -1;
    list.sort((a, b) => {
      let cmp = 0;
      if (key === "name") {
        cmp = a.filename.localeCompare(b.filename, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      } else if (key === "duration") {
        cmp = (a.duration_secs || 0) - (b.duration_secs || 0);
      } else {
        cmp = (a.size_bytes || 0) - (b.size_bytes || 0);
      }
      if (cmp !== 0) return cmp * dir;
      return a.path.localeCompare(b.path);
    });
    const wm =
      wmPath != null ? list.findIndex((v) => v.path === wmPath) : null;
    set({
      videoList: list,
      watermarkClipIndex: wm != null && wm >= 0 ? wm : null,
      listSort: { key, asc: ascending },
    });
  },

  replaceVideo: (oldPath: string, meta: VideoMetadata) => {
    const oldK = normPath(oldPath);
    const newK = normPath(meta.path);
    let cutMarks = { ...get().cutMarks };
    let mediaRevision = bumpRev(get().mediaRevision, meta.path);
    if (oldK !== newK && cutMarks[oldK]) {
      cutMarks[newK] = cutMarks[oldK]!;
      delete cutMarks[oldK];
    }
    set({
      videoList: get().videoList.map((v) =>
        v.path.toLowerCase() === oldPath.toLowerCase() ? meta : v,
      ),
      cutMarks,
      mediaRevision,
    });
  },

  applySplitInList: (oldPath: string, part1: VideoMetadata, part2: VideoMetadata) => {
    const list = [...get().videoList];
    const idx = list.findIndex((v) => v.path.toLowerCase() === oldPath.toLowerCase());
    if (idx < 0) {
      set({ videoList: [...list, part1, part2] });
      return;
    }
    list.splice(idx, 1, part1, part2);
    let wm = get().watermarkClipIndex;
    if (wm != null && wm > idx) wm += 1;
    set({ videoList: list, watermarkClipIndex: wm });
  },

  restoreAfterSplitUndo: (part1Path, part2Path, restored) => {
    const list = [...get().videoList];
    const i1 = list.findIndex(
      (v) => v.path.toLowerCase() === part1Path.toLowerCase(),
    );
    const i2 = list.findIndex(
      (v) => v.path.toLowerCase() === part2Path.toLowerCase(),
    );
    const insertAt = i1 >= 0 ? i1 : i2 >= 0 ? i2 : list.length;
    const next = list.filter(
      (v) =>
        v.path.toLowerCase() !== part1Path.toLowerCase() &&
        v.path.toLowerCase() !== part2Path.toLowerCase(),
    );
    const adjustedInsert =
      insertAt > next.length ? next.length : Math.min(insertAt, next.length);
    next.splice(adjustedInsert, 0, restored);
    let wm = get().watermarkClipIndex;
    if (wm != null) {
      if (i1 === wm || i2 === wm) wm = adjustedInsert;
      else if (wm > adjustedInsert) wm = Math.max(0, wm - 1);
    }
    set({
      videoList: next,
      watermarkClipIndex: wm,
      mediaRevision: bumpRev(get().mediaRevision, restored.path),
    });
  },

  refreshVideo: async (path: string) => {
    try {
      const meta = await probeVideo(path);
      get().replaceVideo(path, meta);
    } catch {
      /* keep previous meta */
    }
  },

  clearVideos: () => {
    const paths = get().videoList.map((v) => v.path);
    set({
      videoList: [],
      importError: null,
      watermarkClipIndex: null,
      listSort: null,
      cutMarks: {},
      mediaRevision: {},
    });
    for (const p of paths) {
      void deleteWorkingCopy(p);
    }
  },

  clearError: () => set({ importError: null }),

  setWatermarkClipIndex: (index) => set({ watermarkClipIndex: index }),

  toggleWatermarkClip: (index) => {
    const cur = get().watermarkClipIndex;
    set({ watermarkClipIndex: cur === index ? null : index });
  },

  ensureDefaultWatermarkClip: () => {
    const { videoList, watermarkClipIndex } = get();
    if (videoList.length === 0) {
      set({ watermarkClipIndex: null });
      return;
    }
    if (watermarkClipIndex != null && watermarkClipIndex < videoList.length) return;
    let best = 0;
    for (let i = 1; i < videoList.length; i++) {
      if (videoList[i]!.duration_secs > videoList[best]!.duration_secs) best = i;
    }
    set({ watermarkClipIndex: best });
  },

  clearWatermarkSelection: () => set({ watermarkClipIndex: null }),

  markTrimmed: (path) => {
    const k = normPath(path);
    set({
      cutMarks: { ...get().cutMarks, [k]: "trim" },
      mediaRevision: bumpRev(get().mediaRevision, path),
    });
  },

  markSplit: (part1, part2, originalPath) => {
    const marks = { ...get().cutMarks };
    delete marks[normPath(originalPath)];
    marks[normPath(part1)] = "split";
    marks[normPath(part2)] = "split";
    let rev = { ...get().mediaRevision };
    rev = bumpRev(rev, part1);
    rev = bumpRev(rev, part2);
    set({ cutMarks: marks, mediaRevision: rev });
  },

  clearCutMarksFor: (paths) => {
    const marks = { ...get().cutMarks };
    let rev = { ...get().mediaRevision };
    for (const p of paths) {
      const k = normPath(p);
      delete marks[k];
      rev = bumpRev(rev, p);
    }
    set({ cutMarks: marks, mediaRevision: rev });
  },

  clearAllCutMarks: () => set({ cutMarks: {} }),

  bumpMediaRevision: (path) => {
    set({ mediaRevision: bumpRev(get().mediaRevision, path) });
  },

  getCutMark: (path) => get().cutMarks[normPath(path)] ?? null,

  getMediaRevision: (path) => get().mediaRevision[normPath(path)] ?? 0,

  hasAnyCutMarks: () => Object.keys(get().cutMarks).length > 0,
}));
