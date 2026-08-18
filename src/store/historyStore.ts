import { create } from "zustand";
import type {
  VorgangAppendEntry,
  VorgangEntry,
  VorgangFileEntry,
} from "@/lib/vorgangHistory";
import type { ProcessedFileEntry } from "@/lib/sdCard";

type HistoryState = {
  vorgaenge: VorgangEntry[];
  vorgaengeLoaded: boolean;
  selectedId: number | null;
  files: VorgangFileEntry[];
  filesVorgangId: number | null;
  appends: VorgangAppendEntry[];
  appendsVorgangId: number | null;
  medien: ProcessedFileEntry[];
  medienLoaded: boolean;
  medienQuery: string;
  setVorgaenge: (rows: VorgangEntry[]) => void;
  patchVorgang: (id: number, fn: (row: VorgangEntry) => VorgangEntry) => void;
  setSelectedId: (id: number | null) => void;
  setFiles: (vorgangId: number, files: VorgangFileEntry[]) => void;
  setAppends: (vorgangId: number, appends: VorgangAppendEntry[]) => void;
  setMedien: (rows: ProcessedFileEntry[], query: string) => void;
  removeVorgaenge: (ids: number[]) => void;
  removeMedien: (ids: number[]) => void;
  clearMedien: () => void;
};

export const useHistoryStore = create<HistoryState>((set) => ({
  vorgaenge: [],
  vorgaengeLoaded: false,
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
      return { vorgaenge: rows, vorgaengeLoaded: true, selectedId };
    }),
  patchVorgang: (id, fn) =>
    set((s) => ({
      vorgaenge: s.vorgaenge.map((row) => (row.id === id ? fn(row) : row)),
    })),
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
      return {
        vorgaenge,
        selectedId,
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
