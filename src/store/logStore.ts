import { create } from "zustand";
import type { LogEntry } from "../lib/tauri";

const MAX_ENTRIES = 3000;

export type LogLevelFilter = "all" | "debug" | "info" | "warn" | "error";

type LogState = {
  open: boolean;
  entries: LogEntry[];
  search: string;
  levelFilter: LogLevelFilter;
  autoScroll: boolean;
  unreadErrors: number;
  lastSeenId: number;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setSearch: (search: string) => void;
  setLevelFilter: (filter: LogLevelFilter) => void;
  setAutoScroll: (autoScroll: boolean) => void;
  replaceEntries: (entries: LogEntry[]) => void;
  appendEntry: (entry: LogEntry) => void;
  clearEntries: () => void;
  markSeen: () => void;
};

function maxId(entries: LogEntry[]): number {
  let max = 0;
  for (const e of entries) {
    if (e.id > max) max = e.id;
  }
  return max;
}

export const useLogStore = create<LogState>((set, get) => ({
  open: false,
  entries: [],
  search: "",
  levelFilter: "all",
  autoScroll: true,
  unreadErrors: 0,
  lastSeenId: 0,

  setOpen: (open) => {
    set({ open });
    if (open) get().markSeen();
  },
  toggleOpen: () => {
    const next = !get().open;
    set({ open: next });
    if (next) get().markSeen();
  },
  setSearch: (search) => set({ search }),
  setLevelFilter: (levelFilter) => set({ levelFilter }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),

  replaceEntries: (entries) => {
    const trimmed =
      entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    set({ entries: trimmed, lastSeenId: maxId(trimmed), unreadErrors: 0 });
  },

  appendEntry: (entry) => {
    const { entries, open, lastSeenId } = get();
    if (entries.some((e) => e.id === entry.id)) return;
    const next = [...entries, entry];
    const trimmed =
      next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    const isError = entry.level.toUpperCase() === "ERROR";
    set({
      entries: trimmed,
      unreadErrors:
        !open && entry.id > lastSeenId && isError
          ? get().unreadErrors + 1
          : get().unreadErrors,
      lastSeenId: open ? Math.max(lastSeenId, entry.id) : lastSeenId,
    });
  },

  clearEntries: () => set({ entries: [], unreadErrors: 0 }),

  markSeen: () => {
    const { entries } = get();
    set({ unreadErrors: 0, lastSeenId: maxId(entries) });
  },
}));

const LEVEL_RANK: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

function filterMinRank(filter: LogLevelFilter): number {
  switch (filter) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
    default:
      return 0;
  }
}

export function filterLogEntries(
  entries: LogEntry[],
  search: string,
  levelFilter: LogLevelFilter,
): LogEntry[] {
  const q = search.trim().toLowerCase();
  const minRank = filterMinRank(levelFilter);
  return entries.filter((e) => {
    const rank = LEVEL_RANK[e.level.toUpperCase()] ?? 20;
    if (rank < minRank) return false;
    if (!q) return true;
    return (
      e.message.toLowerCase().includes(q) ||
      e.level.toLowerCase().includes(q) ||
      e.source.toLowerCase().includes(q) ||
      e.ts.toLowerCase().includes(q)
    );
  });
}
