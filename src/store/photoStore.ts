import { create } from "zustand";
import {
  deleteWorkingCopy,
  discardPhotoEditUndoForPath,
  getFileSizes,
  importPhotos,
  type PhotoMetadata,
} from "../lib/tauri";
import { syncProductsFromMedia } from "../lib/syncProductsFromMedia";
import { isCancellationError } from "../lib/utils";

export type PhotoItem = {
  path: string;
  filename: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  camera_make?: string;
  camera_model?: string;
};

export type PhotoEditMarkKind = "rotate";

function normPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function bumpRev(
  map: Record<string, number>,
  path: string,
): Record<string, number> {
  const k = normPath(path);
  return { ...map, [k]: (map[k] ?? 0) + 1 };
}

type PhotoListState = {
  photoList: PhotoItem[];
  currentIndex: number;
  selected: Set<number>;
  explicitlySelected: boolean;
  /** Indices marked for unpaid-foto watermark (Preview_Foto). */
  watermarkIndices: Set<number>;
  /** path(lower) → edit kind for UI chips / undo */
  editMarks: Record<string, PhotoEditMarkKind>;
  /** path(lower) → bumped when file bytes change in place */
  mediaRevision: Record<string, number>;
  importing: boolean;
  importError: string | null;
  addPhotos: (paths: string[]) => Promise<void>;
  removePhotos: (indices: number[]) => void;
  setCurrentIndex: (index: number) => void;
  toggleSelect: (index: number, mode: "replace" | "toggle" | "range") => void;
  clearSelection: () => void;
  clearPhotos: () => void;
  toggleWatermark: (index: number) => void;
  setWatermarkIndices: (indices: number[]) => void;
  clearWatermarkSelection: () => void;
  /** Fill missing `sizeBytes` from disk (no-op if all present). */
  refreshSizes: (paths?: string[]) => Promise<void>;
  updatePhotoMeta: (
    path: string,
    patch: Partial<Pick<PhotoItem, "width" | "height" | "sizeBytes">>,
  ) => void;
  markRotated: (path: string) => void;
  clearEditMarksFor: (paths: string[]) => void;
  clearAllEditMarks: () => void;
  bumpMediaRevision: (path: string) => void;
  getEditMark: (path: string) => PhotoEditMarkKind | null;
  getMediaRevision: (path: string) => number;
  hasAnyEditMarks: () => boolean;
};

function comparePhotoFilename(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function toItem(meta: PhotoMetadata): PhotoItem {
  const path = meta.path;
  const normalized = path.replace(/\\/g, "/");
  const filename = meta.filename || normalized.split("/").pop() || path;
  return {
    path,
    filename,
    sizeBytes: meta.size_bytes,
    width: meta.width || undefined,
    height: meta.height || undefined,
    camera_make: meta.camera_make || undefined,
    camera_model: meta.camera_model || undefined,
  };
}

export const usePhotoStore = create<PhotoListState>((set, get) => ({
  photoList: [],
  currentIndex: -1,
  selected: new Set(),
  explicitlySelected: false,
  watermarkIndices: new Set(),
  editMarks: {},
  mediaRevision: {},
  importing: false,
  importError: null,

  addPhotos: async (paths: string[]) => {
    if (paths.length === 0) return;
    set({ importing: true, importError: null });
    try {
      const imported = await importPhotos(paths);
      const existing = new Set(get().photoList.map((p) => p.path.toLowerCase()));
      const fresh = imported
        .filter((p) => !existing.has(p.path.toLowerCase()))
        .map(toItem);
      if (fresh.length === 0) {
        set({
          importing: false,
          importError:
            imported.length === 0
              ? "Keine gültigen Foto-Dateien gefunden"
              : "Alle Dateien sind bereits in der Liste",
        });
        return;
      }
      const prev = get().photoList;
      const currentPath =
        get().currentIndex >= 0 ? prev[get().currentIndex]?.path : undefined;
      const wmPaths = new Set(
        [...get().watermarkIndices]
          .map((i) => prev[i]?.path)
          .filter((p): p is string => Boolean(p)),
      );
      // Full list by chrono filename — independent of confirm-dialog order.
      const next = [...prev, ...fresh].sort((a, b) =>
        comparePhotoFilename(a.filename, b.filename),
      );
      const watermarkIndices = new Set<number>();
      next.forEach((p, i) => {
        if (wmPaths.has(p.path)) watermarkIndices.add(i);
      });
      const currentIndex = currentPath
        ? Math.max(
            0,
            next.findIndex((p) => p.path === currentPath),
          )
        : 0;
      set({
        photoList: next,
        currentIndex,
        selected: new Set(),
        explicitlySelected: false,
        watermarkIndices,
        importing: false,
        importError: null,
      });
      void get().refreshSizes(
        fresh.filter((p) => p.sizeBytes == null).map((p) => p.path),
      );
      syncProductsFromMedia({ hasVideos: false, hasPhotos: true });
    } catch (e) {
      set({ importing: false, importError: String(e) });
      if (isCancellationError(e)) throw e;
    }
  },

  removePhotos: (indices: number[]) => {
    const remove = new Set(indices);
    const removedPaths = get()
      .photoList.filter((_, i) => remove.has(i))
      .map((p) => p.path);
    const next = get().photoList.filter((_, i) => !remove.has(i));
    const wm = new Set<number>();
    get().photoList.forEach((_, i) => {
      if (remove.has(i) || !get().watermarkIndices.has(i)) return;
      const removedBefore = [...remove].filter((r) => r < i).length;
      wm.add(i - removedBefore);
    });
    const editMarks = { ...get().editMarks };
    const mediaRevision = { ...get().mediaRevision };
    for (const p of removedPaths) {
      const k = normPath(p);
      delete editMarks[k];
      delete mediaRevision[k];
    }
    set({
      photoList: next,
      currentIndex: next.length === 0 ? -1 : Math.min(get().currentIndex, next.length - 1),
      selected: new Set(),
      explicitlySelected: false,
      watermarkIndices: wm,
      editMarks,
      mediaRevision,
    });
    for (const p of removedPaths) {
      void discardPhotoEditUndoForPath(p);
      void deleteWorkingCopy(p);
    }
  },

  setCurrentIndex: (index: number) => {
    const list = get().photoList;
    if (index < 0 || index >= list.length) return;
    set({ currentIndex: index });
  },

  toggleSelect: (index: number, mode) => {
    const { photoList, selected, currentIndex } = get();
    if (index < 0 || index >= photoList.length) return;

    if (mode === "replace") {
      set({
        currentIndex: index,
        selected: new Set(),
        explicitlySelected: false,
      });
      return;
    }

    if (mode === "toggle") {
      const next = new Set(selected);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      set({
        selected: next,
        explicitlySelected: next.size > 0,
      });
      return;
    }

    const start = Math.min(currentIndex >= 0 ? currentIndex : index, index);
    const end = Math.max(currentIndex >= 0 ? currentIndex : index, index);
    const next = new Set(selected);
    for (let i = start; i <= end; i++) next.add(i);
    set({ selected: next, explicitlySelected: true });
  },

  clearSelection: () => set({ selected: new Set(), explicitlySelected: false }),

  clearPhotos: () => {
    const paths = get().photoList.map((p) => p.path);
    set({
      photoList: [],
      currentIndex: -1,
      selected: new Set(),
      explicitlySelected: false,
      watermarkIndices: new Set(),
      editMarks: {},
      mediaRevision: {},
      importError: null,
    });
    for (const p of paths) {
      void deleteWorkingCopy(p);
    }
  },

  toggleWatermark: (index) => {
    const next = new Set(get().watermarkIndices);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    set({ watermarkIndices: next });
  },

  setWatermarkIndices: (indices) => set({ watermarkIndices: new Set(indices) }),

  clearWatermarkSelection: () => set({ watermarkIndices: new Set() }),

  refreshSizes: async (paths) => {
    const list = get().photoList;
    const targets =
      paths && paths.length > 0
        ? paths
        : list.filter((p) => p.sizeBytes == null).map((p) => p.path);
    if (targets.length === 0) return;
    try {
      const entries = await getFileSizes(targets);
      const byPath = new Map(
        entries.map((e) => [e.path.replace(/\\/g, "/").toLowerCase(), e.size_bytes]),
      );
      const queried = new Set(
        targets.map((p) => p.replace(/\\/g, "/").toLowerCase()),
      );
      set({
        photoList: get().photoList.map((p) => {
          const key = p.path.replace(/\\/g, "/").toLowerCase();
          if (byPath.has(key)) return { ...p, sizeBytes: byPath.get(key)! };
          if (queried.has(key) && p.sizeBytes == null) return { ...p, sizeBytes: 0 };
          return p;
        }),
      });
    } catch {
      /* keep previous sizes */
    }
  },

  updatePhotoMeta: (path, patch) => {
    const key = normPath(path);
    set({
      photoList: get().photoList.map((p) =>
        normPath(p.path) === key ? { ...p, ...patch } : p,
      ),
    });
  },

  markRotated: (path) => {
    const k = normPath(path);
    set({
      editMarks: { ...get().editMarks, [k]: "rotate" },
      mediaRevision: bumpRev(get().mediaRevision, path),
    });
  },

  clearEditMarksFor: (paths) => {
    const marks = { ...get().editMarks };
    let rev = { ...get().mediaRevision };
    for (const p of paths) {
      const k = normPath(p);
      delete marks[k];
      rev = bumpRev(rev, p);
    }
    set({ editMarks: marks, mediaRevision: rev });
  },

  clearAllEditMarks: () => set({ editMarks: {} }),

  bumpMediaRevision: (path) => {
    set({ mediaRevision: bumpRev(get().mediaRevision, path) });
  },

  getEditMark: (path) => get().editMarks[normPath(path)] ?? null,

  getMediaRevision: (path) => get().mediaRevision[normPath(path)] ?? 0,

  hasAnyEditMarks: () => Object.keys(get().editMarks).length > 0,
}));
