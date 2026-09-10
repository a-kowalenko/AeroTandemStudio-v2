import type { SdFileInfo } from "./sdCard";
import { isSidecarPath } from "./media";
import { formatLocaleDate } from "./locale";
import { tr } from "@/i18n";

export type MediaFilter = "all" | "video" | "photo";
export type SortKey = "date" | "name" | "size";
export type ViewMode = "thumbnail" | "details";
export type Density = "comfortable" | "compact";

export const GRID_GAP = 8;
/** Side/top padding — marquee rails sit in this gutter. */
export const GRID_PAD = 28;
export const TILE_META_COMFORTABLE = 42;
export const TILE_META_COMPACT = 22;
export const DETAILS_ROW_H = 40;
export const DETAILS_ROW_COMPACT_H = 32;
export const GROUP_HEADER_H = 32;
export const OVERSCAN_ROWS = 3;
export const MARQUEE_THRESHOLD_PX = 7;

export function gridColumnCount(width: number, density: Density): number {
  if (density === "compact") {
    if (width >= 900) return 6;
    if (width >= 700) return 5;
    if (width >= 520) return 4;
    return 3;
  }
  if (width >= 768) return 4;
  if (width >= 512) return 3;
  return 2;
}

export function tileMetaHeight(density: Density): number {
  return density === "compact" ? TILE_META_COMPACT : TILE_META_COMFORTABLE;
}

export function detailsRowHeight(density: Density): number {
  return density === "compact" ? DETAILS_ROW_COMPACT_H : DETAILS_ROW_H;
}

/** Local calendar day key (YYYY-MM-DD) for grouping. */
export function dayKeyFromEpoch(epoch: number): string {
  if (!epoch) return "unknown";
  const d = new Date(epoch * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dayLabelFromEpoch(epoch: number): string {
  if (!epoch) return tr("sd.selector.unknownDate");
  const d = new Date(epoch * 1000);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round(
    (startToday.getTime() - startThat.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return tr("sd.selector.today");
  if (diffDays === 1) return tr("sd.selector.yesterday");
  return formatLocaleDate(d);
}

export function filterAndSortFiles(
  files: SdFileInfo[],
  mediaFilter: MediaFilter,
  newOnly: boolean,
  sortKey: SortKey,
  sortAsc: boolean,
  query: string,
): SdFileInfo[] {
  const q = query.trim().toLowerCase();
  let list = files.filter(
    (f) => !isSidecarPath(f.filename) && !isSidecarPath(f.path),
  );
  if (mediaFilter === "video") list = list.filter((f) => f.is_video);
  else if (mediaFilter === "photo") list = list.filter((f) => !f.is_video);
  if (newOnly) list = list.filter((f) => !f.already_processed);
  if (q) {
    list = list.filter((f) => f.filename.toLowerCase().includes(q));
  }
  list.sort((a, b) => {
    let cmp = 0;
    if (sortKey === "date") {
      cmp = a.display_epoch - b.display_epoch;
      if (cmp === 0) {
        cmp = a.filename.localeCompare(b.filename, undefined, { numeric: true });
      }
    } else if (sortKey === "name") {
      cmp = a.filename.localeCompare(b.filename, undefined, { numeric: true });
    } else {
      cmp = a.size_bytes - b.size_bytes;
    }
    return sortAsc ? cmp : -cmp;
  });
  return list;
}

export type DateGroup = {
  key: string;
  label: string;
  files: SdFileInfo[];
};

export function groupFilesByDay(files: SdFileInfo[]): DateGroup[] {
  const map = new Map<string, SdFileInfo[]>();
  const order: string[] = [];
  for (const f of files) {
    const key = dayKeyFromEpoch(f.display_epoch);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
      order.push(key);
    }
    bucket.push(f);
  }
  return order.map((key) => {
    const groupFiles = map.get(key)!;
    const epoch = groupFiles[0]?.display_epoch ?? 0;
    return {
      key,
      label: dayLabelFromEpoch(epoch),
      files: groupFiles,
    };
  });
}

export type GridHeaderEntry = {
  kind: "header";
  key: string;
  label: string;
  count: number;
  paths: string[];
  y: number;
  height: number;
};

export type GridTileEntry = {
  kind: "tile";
  file: SdFileInfo;
  groupKey: string;
  indexInFiltered: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GridLayoutEntry = GridHeaderEntry | GridTileEntry;

export type GridLayout = {
  entries: GridLayoutEntry[];
  tiles: GridTileEntry[];
  totalH: number;
  tileW: number;
  rowH: number;
};

export function buildGridLayout(
  filtered: SdFileInfo[],
  opts: {
    width: number;
    cols: number;
    density: Density;
    groupByDate: boolean;
  },
): GridLayout {
  const { width, cols, density, groupByDate } = opts;
  const safeCols = Math.max(1, cols);
  const innerW = Math.max(0, width - GRID_PAD * 2);
  const tileW =
    safeCols > 0
      ? (innerW - GRID_GAP * (safeCols - 1)) / safeCols
      : 160;
  const metaH = tileMetaHeight(density);
  const rowH = Math.max(density === "compact" ? 96 : 120, tileW * (9 / 16) + metaH);
  const entries: GridLayoutEntry[] = [];
  const tiles: GridTileEntry[] = [];

  const indexByPath = new Map(filtered.map((f, i) => [f.path, i]));

  const placeGroup = (groupKey: string, files: SdFileInfo[], startY: number) => {
    let y = startY;
    for (let i = 0; i < files.length; i++) {
      const col = i % safeCols;
      if (col === 0 && i > 0) y += rowH + GRID_GAP;
      const file = files[i];
      const entry: GridTileEntry = {
        kind: "tile",
        file,
        groupKey,
        indexInFiltered: indexByPath.get(file.path) ?? i,
        col,
        x: GRID_PAD + col * (tileW + GRID_GAP),
        y,
        width: tileW,
        height: rowH,
      };
      entries.push(entry);
      tiles.push(entry);
    }
    if (files.length > 0) {
      y += rowH;
    }
    return y;
  };

  let y = GRID_PAD;
  if (groupByDate && filtered.length > 0) {
    const groups = groupFilesByDay(filtered);
    for (const g of groups) {
      const paths = g.files.map((f) => f.path);
      entries.push({
        kind: "header",
        key: g.key,
        label: g.label,
        count: g.files.length,
        paths,
        y,
        height: GROUP_HEADER_H,
      });
      y += GROUP_HEADER_H + 4;
      y = placeGroup(g.key, g.files, y);
      y += GRID_GAP;
    }
  } else {
    y = placeGroup("all", filtered, y);
  }

  const totalH = Math.max(y + GRID_PAD, 1);
  return { entries, tiles, totalH, tileW, rowH };
}

export function visibleGridEntries(
  layout: GridLayout,
  scrollTop: number,
  height: number,
): GridLayoutEntry[] {
  const top = scrollTop - layout.rowH * OVERSCAN_ROWS;
  const bottom = scrollTop + height + layout.rowH * OVERSCAN_ROWS;
  return layout.entries.filter((e) => {
    const y1 = e.y + e.height;
    return y1 >= top && e.y <= bottom;
  });
}

export function collectMarqueeHitsFromLayout(
  tiles: GridTileEntry[],
  box: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const left = Math.min(box.x0, box.x1);
  const right = Math.max(box.x0, box.x1);
  const top = Math.min(box.y0, box.y1);
  const bottom = Math.max(box.y0, box.y1);
  if (right - left <= 4 || bottom - top <= 4) return [];
  const hits: string[] = [];
  for (const t of tiles) {
    const overlaps =
      t.x < right &&
      t.x + t.width > left &&
      t.y < bottom &&
      t.y + t.height > top;
    if (overlaps) hits.push(t.file.path);
  }
  return hits;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human size for selection summary (MB input). */
export function formatSelectedSize(sizeMb: number): string {
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`;
  if (sizeMb >= 10) return `${sizeMb.toFixed(0)} MB`;
  if (sizeMb >= 1) return `${sizeMb.toFixed(1)} MB`;
  if (sizeMb <= 0) return "0 MB";
  return `${Math.max(1, Math.round(sizeMb * 1024))} KB`;
}
