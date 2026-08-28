import { create } from "zustand";
import type {
  VorgangAppendEntry,
  VorgangEntry,
  VorgangFileEntry,
} from "@/lib/vorgangHistory";
import { isFolderMissingProblem } from "@/lib/vorgangLifecycle";
import { isOutstandingUploadState } from "@/lib/uploadState";
import type { ProcessedFileEntry } from "@/lib/sdCard";

type HistoryState = {
  vorgaenge: VorgangEntry[];
  vorgaengeLoaded: boolean;
  /** Historie-button badge: `pending` + `failed` only (not `cancelled`). */
  pendingUploadCount: number;
  /** Output folder missing on disk (probe cache; not persisted). */
  folderMissingById: Record<number, boolean>;
  selectedId: number | null;
  files: VorgangFileEntry[];
  filesVorgangId: number | null;
  appends: VorgangAppendEntry[];
  appendsVorgangId: number | null;
  medien: ProcessedFileEntry[];
  medienLoaded: boolean;
  medienQuery: string;
  setVorgaenge: (rows: VorgangEntry[]) => void;
  setPendingUploadCount: (n: number) => void;
  setFolderMissingById: (map: Record<number, boolean>) => void;
  isFolderMissing: (id: number) => boolean;
  patchVorgang: (id: number, fn: (row: VorgangEntry) => VorgangEntry) => void;
  setSelectedId: (id: number | null) => void;
  setFiles: (vorgangId: number, files: VorgangFileEntry[]) => void;
  setAppends: (vorgangId: number, appends: VorgangAppendEntry[]) => void;
  setMedien: (rows: ProcessedFileEntry[], query: string) => void;
  removeVorgaenge: (ids: number[]) => void;
  removeMedien: (ids: number[]) => void;
  clearMedien: () => void;
};

function countRetryableUploads(
  rows: VorgangEntry[],
  folderMissingById: Record<number, boolean> = {},
): number {
  return rows.reduce((n, e) => {
    if (isFolderMissingProblem(e, folderMissingById)) return n;
    if (!e.correlation_id?.trim() || !e.base_output_dir?.trim()) return n;
    return n + (isOutstandingUploadState(e.upload_state) ? 1 : 0);
  }, 0);
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  vorgaenge: [],
  vorgaengeLoaded: false,
  pendingUploadCount: 0,
  folderMissingById: {},
  selectedId: null,
  files: [],
  filesVorgangId: null,
  appends: [],
  appendsVorgangId: null,
  medien: [],
  medienLoaded: false,
  medienQuery: "",
  setVorgaenge: (rows) =>
    set((s) => {
      const selectedId =
        s.selectedId != null && rows.some((r) => r.id === s.selectedId)
          ? s.selectedId
          : (rows[0]?.id ?? null);
      return {
        vorgaenge: rows,
        vorgaengeLoaded: true,
        selectedId,
        pendingUploadCount: countRetryableUploads(rows, s.folderMissingById),
      };
    }),
  setPendingUploadCount: (n) =>
    set({ pendingUploadCount: Math.max(0, Math.floor(n)) }),
  setFolderMissingById: (folderMissingById) =>
    set((s) => ({
      folderMissingById,
      pendingUploadCount: s.vorgaengeLoaded
        ? countRetryableUploads(s.vorgaenge, folderMissingById)
        : s.pendingUploadCount,
    })),
  isFolderMissing: (id) => get().folderMissingById[id] === true,
  patchVorgang: (id, fn) =>
    set((s) => {
      const vorgaenge = s.vorgaenge.map((row) => (row.id === id ? fn(row) : row));
      return {
        vorgaenge,
        pendingUploadCount: s.vorgaengeLoaded
          ? countRetryableUploads(vorgaenge, s.folderMissingById)
          : s.pendingUploadCount,
      };
    }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setFiles: (vorgangId, files) =>
    set({ files, filesVorgangId: vorgangId }),
  setAppends: (vorgangId, appends) =>
    set({ appends, appendsVorgangId: vorgangId }),
  setMedien: (rows, query) =>
    set({ medien: rows, medienLoaded: true, medienQuery: query }),
  removeVorgaenge: (ids) => {
    const drop = new Set(ids);
    set((s) => {
      const vorgaenge = s.vorgaenge.filter((r) => !drop.has(r.id));
      const selectedId =
        s.selectedId != null && vorgaenge.some((r) => r.id === s.selectedId)
          ? s.selectedId
          : (vorgaenge[0]?.id ?? null);
      const folderMissingById = Object.fromEntries(
        Object.entries(s.folderMissingById).filter(
          ([id]) => !drop.has(Number(id)),
        ),
      );
      return {
        vorgaenge,
        selectedId,
        folderMissingById,
        pendingUploadCount: s.vorgaengeLoaded
          ? countRetryableUploads(vorgaenge, folderMissingById)
          : s.pendingUploadCount,
        files: drop.has(s.filesVorgangId ?? -1) ? [] : s.files,
        filesVorgangId: drop.has(s.filesVorgangId ?? -1)
          ? null
          : s.filesVorgangId,
        appends: drop.has(s.appendsVorgangId ?? -1) ? [] : s.appends,
        appendsVorgangId: drop.has(s.appendsVorgangId ?? -1)
          ? null
          : s.appendsVorgangId,
      };
    });
  },
  removeMedien: (ids) => {
    const drop = new Set(ids);
    set((s) => ({ medien: s.medien.filter((r) => !drop.has(r.id)) }));
  },
  clearMedien: () => set({ medien: [], medienLoaded: true, medienQuery: "" }),
}));
