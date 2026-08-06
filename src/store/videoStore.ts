import { create } from "zustand";
import type { VideoMetadata } from "../lib/tauri";
import { deleteWorkingCopy, importVideos, probeVideo } from "../lib/tauri";
import { syncProductsFromMedia } from "../lib/syncProductsFromMedia";

type VideoListState = {
  videoList: VideoMetadata[];
  importing: boolean;
  importError: string | null;
  /** Index of clip selected for unpaid-video watermark (Preview_Video). */
  watermarkClipIndex: number | null;
  addVideos: (paths: string[]) => Promise<void>;
  removeVideo: (path: string) => void;
  reorderVideos: (activePath: string, overPath: string) => void;
  /** Replace one list entry by path (e.g. after trim overwrite). */
  replaceVideo: (oldPath: string, meta: VideoMetadata) => void;
  /** After split: replace original with part1, insert part2 after it. */
  applySplitInList: (oldPath: string, part1: VideoMetadata, part2: VideoMetadata) => void;
  refreshVideo: (path: string) => Promise<void>;
  clearVideos: () => void;
  clearError: () => void;
  setWatermarkClipIndex: (index: number | null) => void;
  toggleWatermarkClip: (index: number) => void;
  ensureDefaultWatermarkClip: () => void;
  clearWatermarkSelection: () => void;
};

export const useVideoStore = create<VideoListState>((set, get) => ({
  videoList: [],
  importing: false,
  importError: null,
  watermarkClipIndex: null,

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
    set({ videoList: next, watermarkClipIndex: wm });
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
    });
  },

  replaceVideo: (oldPath: string, meta: VideoMetadata) => {
    set({
      videoList: get().videoList.map((v) =>
        v.path.toLowerCase() === oldPath.toLowerCase() ? meta : v,
      ),
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
    set({ videoList: [], importError: null, watermarkClipIndex: null });
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
      if (videoList[i].duration_secs > videoList[best].duration_secs) best = i;
    }
    set({ watermarkClipIndex: best });
  },

  clearWatermarkSelection: () => set({ watermarkClipIndex: null }),
}));
