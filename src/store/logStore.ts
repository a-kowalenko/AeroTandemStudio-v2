import { create } from "zustand";
import type { LogEntry } from "../lib/tauri";

const MAX_ENTRIES = 3000;

export type LogLevelFilter = "debug" | "info" | "warn" | "error";

type LogState = {
  open: boolean;
  entries: LogEntry[];
  search: string;
  /** Minimum recorded level (also used as console display filter). */
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
  /** Append a `log-lines` batch (oldest → newest). */
  appendEntries: (batch: LogEntry[]) => void;
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
  levelFilter: "info",
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

  appendEntries: (batch) => {
    const { entries, open, lastSeenId, unreadErrors } = get();
    // IDs are monotonic — anything at or below the newest known id is a duplicate
    // (e.g. already delivered by `getRecentLogs`).
    let lastId = entries.length > 0 ? entries[entries.length - 1].id : 0;
    const fresh: LogEntry[] = [];
    let newErrors = 0;
    for (const entry of batch) {
      if (entry.id <= lastId) continue;
      lastId = entry.id;
      fresh.push(entry);
      if (!open && entry.id > lastSeenId && entry.level.toUpperCase() === "ERROR") {
        newErrors += 1;
      }
    }
    if (fresh.length === 0) return;
    const next = entries.concat(fresh);
    const trimmed =
      next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    set({
      entries: trimmed,
      unreadErrors: unreadErrors + newErrors,
      lastSeenId: open ? Math.max(lastSeenId, lastId) : lastSeenId,
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
  }
}

export function parseLogLevelFilter(raw: string): LogLevelFilter {
  const t = raw.trim().toLowerCase();
  if (t === "debug" || t === "all") return "debug";
  if (t === "warn" || t === "warning") return "warn";
  if (t === "error") return "error";
  return "info";
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
