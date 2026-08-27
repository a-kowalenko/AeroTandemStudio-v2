import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { SdWorkflowActions } from "../lib/sdCard";
import { emptyCatalogLabel, isMtpDrive } from "../lib/sdCard";
import { tr } from "@/i18n";
import {
  createSdThumbnailLoader,
  type ThumbState,
} from "../lib/sdThumbnailLoader";
import { isSidecarPath } from "../lib/media";
import { formatLocaleDateTime } from "@/lib/locale";
import { cn } from "../lib/utils";
import { useConfigStore } from "../store/configStore";
import { useKundeStore } from "../store/kundeStore";
import { useSdStore } from "../store/sdStore";
import { SdVideoTile } from "./SdVideoTile";
import { SdTilePreview } from "./SdTilePreview";
import { Check, Film, HardDrive, ImageIcon, Loader2, RefreshCw, X } from "lucide-react";

type Props = {
  /** Defaults for action checkboxes (from settings). */
  defaultActions?: SdWorkflowActions;
  onClose: () => void;
  onConfirm: (selectedPaths: string[], actions: SdWorkflowActions) => void;
  onProceedAll?: (actions: SdWorkflowActions) => void;
  onRefresh?: () => void;
};

type FilterType = "all" | "video" | "photo" | "new";
type SortKey = "date" | "name" | "size";
type ViewMode = "thumbnail" | "details";
type SelectMode = "toggle" | "range";
type MarqueeMod = "replace" | "add" | "remove";

const MARQUEE_THRESHOLD_PX = 7;
const GRID_GAP = 8;
const GRID_PAD = 8;
const TILE_META_H = 42;
const DETAILS_ROW_H = 44;
const OVERSCAN_ROWS = 3;

function gridColumnCount(width: number): number {
  if (width >= 768) return 4;
  if (width >= 512) return 3;
  return 2;
}

const statusBadgeBase =
  "rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide shadow-md shadow-black/35";

/** Overlay / row badge for files already known from prior SD runs. */
function KnownBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        statusBadgeBase,
        "border border-amber-400/80 bg-amber-500 text-amber-950",
        className,
      )}
    >
      {t("sd.selector.known")}
    </span>
  );
}

/** Shown on new files only when the dialog also contains known files. */
function NewBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        statusBadgeBase,
        "border border-sky-300/90 bg-sky-500 text-sky-950",
        className,
      )}
    >
      {t("sd.selector.new")}
    </span>
  );
}

function FileStatusBadge({
  alreadyProcessed,
  showNewBadge,
  className,
}: {
  alreadyProcessed: boolean;
  showNewBadge: boolean;
  className?: string;
}) {
  if (alreadyProcessed) {
    return <KnownBadge className={className} />;
  }
  if (showNewBadge) {
    return <NewBadge className={className} />;
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEpoch(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return formatLocaleDateTime(d);
}

/** Compact capture time for the tile meta row (next to file size). */
function formatCaptureTime(epoch: number): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  return formatLocaleDateTime(d);
}

function confirmLabel(actions: SdWorkflowActions, count: number): string {
  const parts: string[] = [];
  if (actions.backup) parts.push(tr("app.sd.backupLabel"));
  if (actions.import) parts.push(tr("app.import.label"));
  if (actions.clear) parts.push(tr("app.sd.clearLabel"));
  if (actions.eject) parts.push(tr("app.sd.ejectLabel"));
  if (parts.length === 0) return tr("sd.selector.executeCount", { count });
  return `${parts.join(" · ")} (${count})`;
}

function CatalogStatusOverlay({
  listing,
  empty,
  drive,
  reason,
  onRefresh,
}: {
  listing: boolean;
  empty: boolean;
  drive: string | null;
  reason: import("../lib/sdCard").ListEmptyReason | null;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  if (!empty) return null;
  if (listing) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 flex min-h-[16rem] items-center justify-center px-6 py-8">
        <span className="inline-flex max-w-md items-center gap-2 text-center text-sm text-muted">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          {t("app.sd.readingFiles")}
        </span>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-10 flex min-h-[16rem] items-center justify-center px-6 py-8">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <p className="text-sm leading-relaxed text-muted">
          {emptyCatalogLabel(drive, reason)}
        </p>
        {onRefresh ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="gap-1.5"
            onClick={onRefresh}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {t("sd.selector.refresh")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SdFileSelector({
  defaultActions,
  onClose,
  onConfirm,
  onProceedAll,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
  // Catalog lives in sdStore so App.tsx does not re-render on every MTP tick.
  const open = useSdStore((s) => s.selectorOpen);
  const drive = useSdStore((s) => s.selectorDrive);
  const files = useSdStore((s) => s.selectorFiles);
  const totalSizeMb = useSdStore((s) => s.selectorTotalMb);
  const mode = useSdStore((s) => s.selectorMode);
  const listing = useSdStore((s) => s.selectorListing);
  const emptyReason = useSdStore((s) => s.selectorEmptyReason);
  const locationLabel = drive
    ? t("common.labels.drive", { name: drive })
    : t("common.labels.sdCard");
  const [viewMode, setViewMode] = useState<ViewMode>("thumbnail");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  const [actions, setActions] = useState<SdWorkflowActions>({
    backup: true,
    import: true,
    clear: false,
    eject: false,
    scanQr: false,
  });
  const config = useConfigStore((s) => s.config);
  const formMode = useKundeStore((s) => s.kunde.form_mode);
  const [dragBox, setDragBox] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  /** True while marquee is past the movement threshold. */
  const [selectionDragging, setSelectionDragging] = useState(false);
  /** At most one video tile may be actively previewing / playing. */
  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
  /** Grid element state — Radix Presence mounts dialog content one frame late; ref-only misses IO setup. */
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const [detailsEl, setDetailsEl] = useState<HTMLDivElement | null>(null);
  const [gridMetrics, setGridMetrics] = useState({
    scrollTop: 0,
    height: 0,
    width: 0,
  });
  const [detailsMetrics, setDetailsMetrics] = useState({
    scrollTop: 0,
    height: 0,
  });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Map<string, HTMLElement>>(new Map());
  const loaderRef = useRef(createSdThumbnailLoader());
  /** Last non-range select path — Shift-range is resolved against `filtered`. */
  const anchorPathRef = useRef<string | null>(null);
  const pendingMarqueeRef = useRef<{
    pointerId: number;
    x0: number;
    y0: number;
    clientX0: number;
    clientY0: number;
    mod: MarqueeMod;
  } | null>(null);
  const marqueeModRef = useRef<MarqueeMod>("replace");
  /** Suppress tile click after a completed marquee gesture. */
  const suppressClickRef = useRef(false);
  const dragBoxRef = useRef<typeof dragBox>(null);
  /** Skip the following checkbox onCheckedChange after Shift-range via pointer. */
  const shiftCheckboxRef = useRef(false);
  const wasEmptyCatalogRef = useRef(false);

  const attachGridRef = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    setGridEl((prev) => (prev === el ? prev : el));
  }, []);

  const attachDetailsRef = useCallback((el: HTMLDivElement | null) => {
    setDetailsEl((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    if (!gridEl) return;
    let raf = 0;
    const measure = () => {
      setGridMetrics({
        scrollTop: gridEl.scrollTop,
        height: gridEl.clientHeight,
        width: gridEl.clientWidth,
      });
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    const ro = new ResizeObserver(onScroll);
    ro.observe(gridEl);
    gridEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      gridEl.removeEventListener("scroll", onScroll);
    };
  }, [gridEl]);

  useEffect(() => {
    if (!detailsEl) return;
    let raf = 0;
    const measure = () => {
      setDetailsMetrics({
        scrollTop: detailsEl.scrollTop,
        height: detailsEl.clientHeight,
      });
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    const ro = new ResizeObserver(onScroll);
    ro.observe(detailsEl);
    detailsEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      detailsEl.removeEventListener("scroll", onScroll);
    };
  }, [detailsEl]);

  // Path set only — enrich must not reset selection / thumbs.
  const filePathsKey = files.map((f) => f.path).join("\0");

  useEffect(() => {
    if (!open) return;
    wasEmptyCatalogRef.current = false;
    setSelected(new Set());
    setActiveVideoPath(null);
    anchorPathRef.current = null;
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    setDragBox(null);
    setSelectionDragging(false);
    const isQrMode = formMode === "kunde";
    const settingsQrOn =
      Boolean(config?.qr_check_enabled) ||
      Boolean(config?.photo_qr_check_enabled);
    setActions({
      backup: defaultActions?.backup ?? true,
      import: defaultActions?.import ?? true,
      // Clear only with backup
      clear: Boolean(defaultActions?.clear) && Boolean(defaultActions?.backup ?? true),
      eject: Boolean(defaultActions?.eject),
      // QR mode already on → skip auto-scan by default; else follow settings.
      scanQr: isQrMode ? false : settingsQrOn,
    });
    // Reset only when the dialog opens or the drive changes — streaming MTP
    // catalogs must not wipe an in-progress selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, drive]);

  useEffect(() => {
    if (!open || listing) return;
    const empty = files.length === 0;
    if (empty) {
      wasEmptyCatalogRef.current = true;
      setActions((prev) => ({
        ...prev,
        backup: false,
        import: false,
        clear: false,
        scanQr: false,
      }));
      return;
    }
    if (!wasEmptyCatalogRef.current) return;
    wasEmptyCatalogRef.current = false;
    const isQrMode = formMode === "kunde";
    const settingsQrOn =
      Boolean(config?.qr_check_enabled) ||
      Boolean(config?.photo_qr_check_enabled);
    setActions({
      backup: defaultActions?.backup ?? true,
      import: defaultActions?.import ?? true,
      clear: Boolean(defaultActions?.clear) && Boolean(defaultActions?.backup ?? true),
      eject: Boolean(defaultActions?.eject),
      scanQr: isQrMode ? false : settingsQrOn,
    });
  }, [
    open,
    listing,
    files.length,
    formMode,
    config?.qr_check_enabled,
    config?.photo_qr_check_enabled,
    defaultActions,
  ]);

  useEffect(() => {
    if (!open) return;
    setThumbs((prev) => {
      const snap = loaderRef.current.snapshotFor(files.map((f) => f.path));
      return { ...snap, ...prev };
    });
  }, [open, filePathsKey]);

  // Loader lifetime must follow `open` only — stopping on unrelated re-renders
  // cancels in-flight FFmpeg thumbs before they finish.
  useEffect(() => {
    const loader = loaderRef.current;
    if (!open) {
      loader.stop();
      return;
    }
    loader.start();
    return () => loader.stop();
  }, [open]);

  useEffect(() => {
    const loader = loaderRef.current;
    loader.setListener((batch) => {
      setThumbs((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [path, state] of batch) {
          const cur = next[path];
          if (cur?.quality === "hq" && state.quality === "lq") continue;
          if (cur?.url === state.url && cur?.quality === state.quality) continue;
          next[path] = state;
          changed = true;
        }
        return changed ? next : prev;
      });
    });
    return () => loader.setListener(null);
  }, []);

  const filtered = useMemo(() => {
    let list = files.filter(
      (f) => !isSidecarPath(f.filename) && !isSidecarPath(f.path),
    );
    if (filterType === "video") list = list.filter((f) => f.is_video);
    else if (filterType === "photo") list = list.filter((f) => !f.is_video);
    else if (filterType === "new") list = list.filter((f) => !f.already_processed);
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
  }, [files, filterType, sortKey, sortAsc]);

  const icaVirtual = isMtpDrive(drive);
  const gridCols = gridColumnCount(gridMetrics.width);
  const gridInnerW = Math.max(0, gridMetrics.width - GRID_PAD * 2);
  const tileW =
    gridCols > 0
      ? (gridInnerW - GRID_GAP * (gridCols - 1)) / gridCols
      : 160;
  const gridRowH = Math.max(120, tileW * (9 / 16) + TILE_META_H);
  const gridRowCount = Math.ceil(filtered.length / Math.max(1, gridCols));
  const gridStartRow = Math.max(
    0,
    Math.floor(gridMetrics.scrollTop / gridRowH) - OVERSCAN_ROWS,
  );
  const gridEndRow = Math.min(
    gridRowCount,
    Math.ceil((gridMetrics.scrollTop + gridMetrics.height) / gridRowH) +
      OVERSCAN_ROWS,
  );
  const gridStart = gridStartRow * gridCols;
  const gridEnd = Math.min(filtered.length, gridEndRow * gridCols);
  const visibleTiles = filtered.slice(gridStart, gridEnd);
  const gridPadTop = gridStartRow * gridRowH;
  const gridTotalH = gridRowCount * gridRowH;

  const detailsStart = Math.max(
    0,
    Math.floor(detailsMetrics.scrollTop / DETAILS_ROW_H) - 8,
  );
  const detailsEnd = Math.min(
    filtered.length,
    Math.ceil((detailsMetrics.scrollTop + detailsMetrics.height) / DETAILS_ROW_H) +
      8,
  );
  const visibleDetails = filtered.slice(detailsStart, detailsEnd);
  const detailsPadTop = detailsStart * DETAILS_ROW_H;
  const detailsPadBottom = Math.max(
    0,
    (filtered.length - detailsEnd) * DETAILS_ROW_H,
  );

  const selectedSizeMb = useMemo(() => {
    let sum = 0;
    for (const f of files) {
      if (selected.has(f.path)) sum += f.size_bytes;
    }
    return sum / (1024 * 1024);
  }, [files, selected]);

  const mediaCounts = useMemo(() => {
    let videos = 0;
    let photos = 0;
    for (const f of files) {
      if (f.is_video) videos += 1;
      else photos += 1;
    }
    return { videos, photos };
  }, [files]);

  const selectedCounts = useMemo(() => {
    let videos = 0;
    let photos = 0;
    for (const f of files) {
      if (!selected.has(f.path)) continue;
      if (f.is_video) videos += 1;
      else photos += 1;
    }
    return { videos, photos, total: videos + photos };
  }, [files, selected]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((f) => selected.has(f.path));
  const newInFiltered = useMemo(
    () => filtered.filter((f) => !f.already_processed),
    [filtered],
  );
  const allNewSelected =
    newInFiltered.length > 0 &&
    newInFiltered.every((f) => selected.has(f.path)) &&
    selected.size === newInFiltered.length;
  const noneSelected = selected.size === 0;
  /** Mixed known+new → show Neu badges; all-new → no status badges. */
  const showNewBadges = useMemo(() => {
    let hasKnown = false;
    let hasNew = false;
    for (const f of files) {
      if (f.already_processed) hasKnown = true;
      else hasNew = true;
      if (hasKnown && hasNew) return true;
    }
    return false;
  }, [files]);

  const filteredPathsKey = useMemo(
    () => filtered.map((f) => f.path).join("\0"),
    [filtered],
  );

  // Eager first page + IntersectionObserver for the rest (thumbnail grid + details rows).
  // Depend on scroll-root state so setup runs after Radix Presence mounts the root.
  useEffect(() => {
    if (!open) return;
    // MTP listing shares the ICA main-thread session — wait until the catalog is done.
    if (listing && isMtpDrive(drive)) return;
    const root = viewMode === "thumbnail" ? gridEl : detailsEl;
    if (!root) return;

    const loader = loaderRef.current;
    const icaVirtual = isMtpDrive(drive);
    const upgradeToHq = viewMode === "thumbnail" && !icaVirtual;
    const eagerCount = icaVirtual
      ? 12
      : viewMode === "thumbnail"
        ? 32
        : 28;
    for (const file of filtered.slice(0, eagerCount)) {
      loader.setVisible(file.path, true, { upgradeToHq });
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.thumbPath;
          if (!path) continue;
          loader.setVisible(path, entry.isIntersecting, { upgradeToHq });
        }
      },
      {
        root,
        rootMargin: viewMode === "thumbnail" ? "240px 0px" : "160px 0px",
        threshold: 0,
      },
    );

    const observed = new WeakSet<Element>();
    const observeAll = () => {
      root.querySelectorAll<HTMLElement>("[data-thumb-path]").forEach((el) => {
        if (observed.has(el)) return;
        observed.add(el);
        io.observe(el);
      });
    };
    observeAll();
    const mo = new MutationObserver(() => observeAll());
    mo.observe(root, { childList: true, subtree: true });
    const t = window.setTimeout(observeAll, 0);

    return () => {
      window.clearTimeout(t);
      mo.disconnect();
      io.disconnect();
      loader.releaseAllVisible();
    };
  }, [open, viewMode, gridEl, detailsEl, drive, listing, filteredPathsKey]);

  function selectPath(path: string, mode: SelectMode) {
    if (suppressClickRef.current) return;

    if (mode === "range") {
      const anchor = anchorPathRef.current;
      const startIdx =
        anchor != null ? filtered.findIndex((f) => f.path === anchor) : -1;
      const endIdx = filtered.findIndex((f) => f.path === path);
      if (startIdx < 0 || endIdx < 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchorPathRef.current = path;
        return;
      }
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(filtered[i].path);
        return next;
      });
      return;
    }

    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    anchorPathRef.current = path;
  }

  /** Checkbox: Shift-range on pointerdown; plain click / Space via onCheckedChange. */
  function onCheckboxPointerDown(path: string, e: React.PointerEvent) {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    shiftCheckboxRef.current = true;
    selectPath(path, "range");
  }

  function onCheckboxCheckedChange(path: string) {
    if (shiftCheckboxRef.current) {
      shiftCheckboxRef.current = false;
      return;
    }
    selectPath(path, "toggle");
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((f) => f.path)));
    anchorPathRef.current =
      filtered.length > 0 ? filtered[filtered.length - 1].path : null;
  }

  function selectOnlyNew() {
    const paths = newInFiltered.map((f) => f.path);
    setSelected(new Set(paths));
    anchorPathRef.current =
      paths.length > 0 ? paths[paths.length - 1] : null;
  }

  function clearSelection() {
    setSelected(new Set());
    anchorPathRef.current = null;
  }

  function patchAction<K extends keyof SdWorkflowActions>(key: K, value: boolean) {
    setActions((prev) => {
      if (key === "backup" && !value) {
        // Clear is only allowed together with backup.
        return { ...prev, backup: false, clear: false };
      }
      if (key === "clear" && value && !prev.backup) {
        return prev;
      }
      if (key === "import" && !value) {
        return { ...prev, import: false, scanQr: false };
      }
      if (key === "import" && value) {
        const isQrMode = formMode === "kunde";
        const settingsQrOn =
          Boolean(config?.qr_check_enabled) ||
          Boolean(config?.photo_qr_check_enabled);
        return {
          ...prev,
          import: true,
          scanQr: isQrMode ? false : settingsQrOn,
        };
      }
      return { ...prev, [key]: value };
    });
  }

  function gridLocalPoint(e: { clientX: number; clientY: number }) {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: e.clientX - rect.left + el.scrollLeft,
      y: e.clientY - rect.top + el.scrollTop,
    };
  }

  function marqueeModFromEvent(e: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }): MarqueeMod {
    if (e.altKey) return "remove";
    if (e.ctrlKey || e.metaKey) return "add";
    return "replace";
  }

  function collectMarqueeHits(box: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): string[] {
    const left = Math.min(box.x0, box.x1);
    const right = Math.max(box.x0, box.x1);
    const top = Math.min(box.y0, box.y1);
    const bottom = Math.max(box.y0, box.y1);
    if (right - left <= 4 || bottom - top <= 4) return [];

    const colW = tileW + GRID_GAP;
    const rowH = gridRowH;
    const hits: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const col = i % gridCols;
      const row = Math.floor(i / gridCols);
      const tx = GRID_PAD + col * colW;
      const ty = GRID_PAD + row * rowH;
      const overlaps =
        tx < right && tx + tileW > left && ty < bottom && ty + rowH > top;
      if (overlaps) hits.push(filtered[i].path);
    }
    return hits;
  }

  function commitMarquee(mod: MarqueeMod, hits: string[]) {
    if (hits.length === 0) return;
    setSelected((prev) => {
      if (mod === "replace") return new Set(hits);
      if (mod === "add") {
        const next = new Set(prev);
        for (const p of hits) next.add(p);
        return next;
      }
      const next = new Set(prev);
      for (const p of hits) next.delete(p);
      return next;
    });
    anchorPathRef.current = hits[hits.length - 1] ?? null;
  }

  function onGridPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || viewMode !== "thumbnail") return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-controls]")) return;
    if (target.closest("[data-no-marquee]")) return;
    if (target.closest('[role="checkbox"]')) return;
    if (target.closest("[data-sd-immersive-overlay]")) return;

    const onMarqueeOk = target.closest("[data-marquee-ok]");
    const onTile = target.closest("[data-tile]");
    // Empty chrome always; tiles only via data-marquee-ok (photo / video caption).
    if (onTile && !onMarqueeOk) return;

    const pt = gridLocalPoint(e);
    if (!pt) return;
    pendingMarqueeRef.current = {
      pointerId: e.pointerId,
      x0: pt.x,
      y0: pt.y,
      clientX0: e.clientX,
      clientY0: e.clientY,
      mod: marqueeModFromEvent(e),
    };
  }

  function onGridPointerMove(e: React.PointerEvent) {
    const pending = pendingMarqueeRef.current;
    if (pending && !dragBoxRef.current) {
      if (e.pointerId !== pending.pointerId) return;
      const dx = Math.abs(e.clientX - pending.clientX0);
      const dy = Math.abs(e.clientY - pending.clientY0);
      if (dx > MARQUEE_THRESHOLD_PX || dy > MARQUEE_THRESHOLD_PX) {
        const pt = gridLocalPoint(e);
        if (!pt) return;
        marqueeModRef.current = pending.mod;
        suppressClickRef.current = true;
        const next = {
          x0: pending.x0,
          y0: pending.y0,
          x1: pt.x,
          y1: pt.y,
        };
        dragBoxRef.current = next;
        setSelectionDragging(true);
        setDragBox(next);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    if (!dragBoxRef.current) return;
    const pt = gridLocalPoint(e);
    if (!pt) return;
    const next = { ...dragBoxRef.current, x1: pt.x, y1: pt.y };
    dragBoxRef.current = next;
    setDragBox(next);
  }

  function endMarqueeGesture(activeBox: typeof dragBox) {
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    if (activeBox) {
      const hits = collectMarqueeHits(activeBox);
      commitMarquee(marqueeModRef.current, hits);
      setDragBox(null);
      setSelectionDragging(false);
      // Keep suppress until after the synthetic click from the originating element.
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      return;
    }
    suppressClickRef.current = false;
  }

  function onGridPointerUp() {
    endMarqueeGesture(dragBoxRef.current);
  }

  function onGridPointerCancel() {
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    setDragBox(null);
    setSelectionDragging(false);
    suppressClickRef.current = false;
  }

  const title =
    mode === "size_limit"
      ? t("sd.selector.titleSizeLimit")
      : t("sd.selector.title");

  const anyAction = actions.backup || actions.import || actions.clear;
  const catalogEmpty = !listing && files.length === 0;
  const confirmDisabled = listing
    ? true
    : catalogEmpty
      ? !actions.eject
      : selected.size === 0 || !anyAction;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] w-[min(1100px,95vw)] max-w-none flex-col gap-3 overflow-hidden"
      >
        <DialogHeader className="space-y-2.5 pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {locationLabel}
            {`, ${t("common.labels.filesCount", { count: files.length })}, ${totalSizeMb.toFixed(1)} MB`}
            {mediaCounts.videos > 0
              ? t("sd.selector.summaryVideos", { count: mediaCounts.videos })
              : ""}
            {mediaCounts.photos > 0
              ? t("sd.selector.summaryPhotos", { count: mediaCounts.photos })
              : ""}
            {selectedCounts.total > 0
              ? t("sd.selector.summarySelected", {
                  count: selectedCounts.total,
                  sizeMb: selectedSizeMb.toFixed(1),
                })
              : ""}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-card-elevated/80 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-primary/20">
                <HardDrive className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight text-foreground">
                  {locationLabel}
                </p>
                <p className="text-xs tabular-nums text-muted">
                  {listing ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden
                      />
                      {t("sd.selector.readingInline", { count: files.length })}
                    </span>
                  ) : (
                    t("common.labels.filesCountWithSize", {
                      count: files.length,
                      sizeMb: totalSizeMb.toFixed(1),
                    })
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {mediaCounts.videos > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                  <Film className="h-3 w-3" aria-hidden />
                  {mediaCounts.videos}{" "}
                  {mediaCounts.videos === 1
                    ? t("common.labels.video")
                    : t("common.labels.videos")}
                </span>
              ) : null}
              {mediaCounts.photos > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                  <ImageIcon className="h-3 w-3" aria-hidden />
                  {mediaCounts.photos}{" "}
                  {mediaCounts.photos === 1
                    ? t("common.labels.photo")
                    : t("common.labels.photos")}
                </span>
              ) : null}
              {selectedCounts.total > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-card px-2.5 py-0.5 text-xs font-medium text-primary tabular-nums">
                  <span>
                    gewählt: {selectedCounts.total} · {selectedSizeMb.toFixed(1)}{" "}
                    MB
                  </span>
                  {selectedCounts.videos > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-primary/90">
                      <Film className="h-3 w-3" aria-hidden />
                      {selectedCounts.videos}
                    </span>
                  ) : null}
                  {selectedCounts.photos > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-primary/90">
                      <ImageIcon className="h-3 w-3" aria-hidden />
                      {selectedCounts.photos}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={viewMode === "thumbnail" ? "default" : "secondary"}
              onClick={() => setViewMode("thumbnail")}
            >
              {t("sd.selector.viewTiles")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === "details" ? "default" : "secondary"}
              onClick={() => setViewMode("details")}
            >
              {t("sd.selector.viewDetails")}
            </Button>
          </div>
          <Select
            value={filterType}
            onValueChange={(v) => setFilterType(v as FilterType)}
          >
            <SelectTrigger className="h-8 w-[128px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.labels.all")}</SelectItem>
              <SelectItem value="video">{t("common.labels.videos")}</SelectItem>
              <SelectItem value="photo">{t("common.labels.photos")}</SelectItem>
              <SelectItem value="new">{t("common.filter.newOnly")}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortKey}
            onValueChange={(v) => setSortKey(v as SortKey)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">{t("common.labels.date")}</SelectItem>
              <SelectItem value="name">{t("common.labels.name")}</SelectItem>
              <SelectItem value="size">{t("common.labels.size")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setSortAsc((v) => !v)}
          >
            {sortAsc ? t("common.labels.sortAsc") : t("common.labels.sortDesc")}
          </Button>
          <span
            className="mx-1 h-6 w-px shrink-0 bg-border"
            aria-hidden
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={cn(
              "gap-1.5",
              allFilteredSelected &&
                "border-primary/30 bg-primary-soft text-primary hover:bg-primary-soft",
            )}
            onClick={selectAllFiltered}
          >
            {allFilteredSelected ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : null}
            {t("sd.selector.selectAll")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={newInFiltered.length === 0}
            className={cn(
              "gap-1.5",
              allNewSelected &&
                "border-primary/30 bg-primary-soft text-primary hover:bg-primary-soft",
            )}
            onClick={selectOnlyNew}
          >
            {allNewSelected ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : null}
            {t("common.filter.newOnly")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn("gap-1.5", noneSelected && "text-muted")}
            onClick={clearSelection}
          >
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("common.labels.none")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border/60 bg-card-elevated px-3 py-2 text-sm">
          <span className="text-xs font-medium text-muted">{t("common.labels.actions")}:</span>
          <label className={cn("flex items-center gap-2", catalogEmpty && "opacity-50")}>
            <Checkbox
              checked={actions.backup}
              disabled={catalogEmpty}
              onCheckedChange={(v) => patchAction("backup", v === true)}
            />
            {t("app.sd.backupLabel")}
          </label>
          <label className={cn("flex items-center gap-2", catalogEmpty && "opacity-50")}>
            <Checkbox
              checked={actions.import}
              disabled={catalogEmpty}
              onCheckedChange={(v) => patchAction("import", v === true)}
            />
            {t("app.import.label")}
          </label>
          <label
            className={cn(
              "flex items-center gap-2",
              (!actions.backup || catalogEmpty) && "opacity-50",
            )}
            title={
              catalogEmpty
                ? t("sd.selector.clearNoFiles")
                : actions.backup
                  ? t("sd.selector.clearAfterBackup")
                  : t("sd.selector.clearNeedsBackup")
            }
          >
            <Checkbox
              checked={actions.clear}
              disabled={!actions.backup || catalogEmpty}
              onCheckedChange={(v) => patchAction("clear", v === true)}
            />
            {t("sd.selector.clearSd")}
          </label>
          <label
            className="flex items-center gap-2"
            title={t("sd.selector.ejectAfterBackupTitle")}
          >
            <Checkbox
              checked={actions.eject}
              onCheckedChange={(v) => patchAction("eject", v === true)}
            />
            {t("app.sd.ejectLabel")}
          </label>
          {!actions.backup ? (
            <span className="text-[11px] text-muted">
              {t("sd.selector.clearOnlyAfterBackupHint")}
            </span>
          ) : null}
          <div
            className={cn(
              "ml-auto flex items-center gap-2",
              !actions.import && "opacity-50",
            )}
            title={
              actions.import
                ? t("sd.selector.scanImportedQr")
                : t("sd.selector.scanNeedsImport")
            }
          >
            <Switch
              id="sd-scan-qr"
              checked={Boolean(actions.scanQr)}
              disabled={!actions.import || catalogEmpty}
              onCheckedChange={(v) => patchAction("scanQr", v === true)}
            />
            <Label
              htmlFor="sd-scan-qr"
              className={cn(
                "cursor-pointer text-sm font-normal",
                !actions.import && "pointer-events-none",
              )}
            >
              {t("media.list.scanQr")}
            </Label>
          </div>
        </div>

        {viewMode === "thumbnail" ? (
          <div
            ref={attachGridRef}
            className={cn(
              "relative min-h-[16rem] flex-1 overflow-auto rounded-md border border-border/60 bg-card-elevated p-2 pr-3 [scrollbar-gutter:stable]",
              selectionDragging && "select-none",
            )}
            onPointerDown={onGridPointerDown}
            onPointerMove={onGridPointerMove}
            onPointerUp={onGridPointerUp}
            onPointerCancel={onGridPointerCancel}
          >
            <div
              className="relative"
              style={{ height: Math.max(gridTotalH, 1) }}
            >
              <div
                className="grid gap-2"
                style={{
                  position: "absolute",
                  top: gridPadTop,
                  left: 0,
                  right: 0,
                  gridTemplateColumns: `repeat(${Math.max(gridCols, 1)}, minmax(0, 1fr))`,
                }}
              >
              {visibleTiles.map((file) => {
                const isSel = selected.has(file.path);
                const captureLabel = formatCaptureTime(file.display_epoch);
                const setTileEl = (el: HTMLElement | null) => {
                  if (el) tileRefs.current.set(file.path, el);
                  else tileRefs.current.delete(file.path);
                };

                if (file.is_video && !icaVirtual) {
                  return (
                    <SdVideoTile
                      key={file.path}
                      path={file.path}
                      filename={file.filename}
                      sizeLabel={formatBytes(file.size_bytes)}
                      captureLabel={captureLabel}
                      thumbUrl={thumbs[file.path]?.url}
                      thumbQuality={thumbs[file.path]?.quality}
                      selected={isSel}
                      alreadyProcessed={file.already_processed}
                      showNewBadge={showNewBadges}
                      isActive={activeVideoPath === file.path}
                      selectionLocked={selectionDragging}
                      previewEnabled={!icaVirtual}
                      onActivate={() => setActiveVideoPath(file.path)}
                      onDeactivate={() =>
                        setActiveVideoPath((prev) => (prev === file.path ? null : prev))
                      }
                      onSelect={(ev) =>
                        selectPath(file.path, ev.shiftKey ? "range" : "toggle")
                      }
                      tileRef={setTileEl}
                    />
                  );
                }

                return (
                  <div
                    key={file.path}
                    data-tile
                    data-thumb-path={file.path}
                    ref={setTileEl}
                    className={cn(
                      "relative flex flex-col overflow-hidden rounded-md text-left transition",
                      isSel
                        ? "border-2 border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
                        : "border border-border/70",
                    )}
                  >
                    <SdTilePreview
                      thumbUrl={thumbs[file.path]?.url}
                      thumbQuality={thumbs[file.path]?.quality}
                      placeholder="pulse"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("[data-no-marquee]")) {
                          return;
                        }
                        selectPath(file.path, e.shiftKey ? "range" : "toggle");
                      }}
                    >
                      <div
                        className="absolute top-1.5 left-1.5 z-10"
                        data-no-marquee=""
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSel}
                          onPointerDown={(e) =>
                            onCheckboxPointerDown(file.path, e)
                          }
                          onCheckedChange={() =>
                            onCheckboxCheckedChange(file.path)
                          }
                          aria-label={t("common.actions.selectNamed", { name: file.filename })}
                          className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
                        />
                      </div>
                      <FileStatusBadge
                        alreadyProcessed={file.already_processed}
                        showNewBadge={showNewBadges}
                        className="absolute top-1.5 right-1.5 z-10"
                      />
                      {file.is_video ? (
                        <Film
                          className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 h-3.5 w-3.5 text-white/90 drop-shadow"
                          aria-hidden
                        />
                      ) : null}
                    </SdTilePreview>
                    <button
                      type="button"
                      data-marquee-ok=""
                      className="truncate px-2 py-1 text-left text-[11px] hover:bg-black/5"
                      onClick={(e) =>
                        selectPath(file.path, e.shiftKey ? "range" : "toggle")
                      }
                    >
                      {file.filename}
                    </button>
                    <button
                      type="button"
                      data-marquee-ok=""
                      className="flex w-full items-baseline justify-between gap-2 px-2 pb-1 text-left text-[10px] text-muted hover:bg-black/5"
                      onClick={(e) =>
                        selectPath(file.path, e.shiftKey ? "range" : "toggle")
                      }
                    >
                      <span className="min-w-0 truncate">
                        {formatBytes(file.size_bytes)}
                      </span>
                      {captureLabel ? (
                        <span className="shrink-0 tabular-nums">{captureLabel}</span>
                      ) : null}
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
            <CatalogStatusOverlay
              listing={listing}
              empty={files.length === 0}
              drive={drive}
              reason={emptyReason}
              onRefresh={onRefresh}
            />
            {dragBox && (
              <div
                className="pointer-events-none absolute border border-primary bg-primary-soft"
                style={{
                  left: Math.min(dragBox.x0, dragBox.x1),
                  top: Math.min(dragBox.y0, dragBox.y1),
                  width: Math.abs(dragBox.x1 - dragBox.x0),
                  height: Math.abs(dragBox.y1 - dragBox.y0),
                }}
              />
            )}
          </div>
        ) : (
          <div
            ref={attachDetailsRef}
            className="relative min-h-[16rem] flex-1 overflow-auto rounded-md border border-border/60"
          >
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-[1] bg-card">
                <tr className="border-b border-border/60">
                  <th className="w-8 p-2" />
                  <th className="w-14 p-2">{t("common.labels.preview")}</th>
                  <th className="p-2">{t("common.labels.name")}</th>
                  <th className="p-2">{t("common.labels.type")}</th>
                  <th className="p-2">{t("common.labels.size")}</th>
                  <th className="p-2">{t("common.labels.date")}</th>
                </tr>
              </thead>
              <tbody>
                {detailsPadTop > 0 ? (
                  <tr aria-hidden>
                    <td colSpan={6} style={{ height: detailsPadTop, padding: 0 }} />
                  </tr>
                ) : null}
                {visibleDetails.map((file) => {
                  const thumb = thumbs[file.path];
                  return (
                    <tr
                      key={file.path}
                      className={cn(
                        "border-b border-border/40 hover:bg-black/5",
                        selected.has(file.path) && "bg-primary-soft",
                      )}
                      onClick={(e) =>
                        selectPath(file.path, e.shiftKey ? "range" : "toggle")
                      }
                    >
                      <td
                        className="p-2"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={selected.has(file.path)}
                          onPointerDown={(e) =>
                            onCheckboxPointerDown(file.path, e)
                          }
                          onCheckedChange={() =>
                            onCheckboxCheckedChange(file.path)
                          }
                        />
                      </td>
                      <td className="p-1.5">
                        <SdTilePreview
                          thumbPath={file.path}
                          thumbUrl={thumb?.url}
                          thumbQuality={thumb?.quality}
                          placeholder="pulse"
                          suppressLqEnhance
                          layout="inline"
                          className="h-9 w-14 shrink-0 rounded"
                        />
                      </td>
                      <td className="max-w-[280px] p-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{file.filename}</span>
                          <FileStatusBadge
                            alreadyProcessed={file.already_processed}
                            showNewBadge={showNewBadges}
                            className="shrink-0 shadow-sm"
                          />
                        </div>
                      </td>
                      <td className="p-2">{file.is_video ? t("common.labels.video") : t("common.labels.photo")}</td>
                      <td className="p-2">{formatBytes(file.size_bytes)}</td>
                      <td className="p-2">{formatEpoch(file.display_epoch)}</td>
                    </tr>
                  );
                })}
                {detailsPadBottom > 0 ? (
                  <tr aria-hidden>
                    <td
                      colSpan={6}
                      style={{ height: detailsPadBottom, padding: 0 }}
                    />
                  </tr>
                ) : null}
              </tbody>
            </table>
            <CatalogStatusOverlay
              listing={listing}
              empty={files.length === 0}
              drive={drive}
              reason={emptyReason}
              onRefresh={onRefresh}
            />
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.actions.cancel")}
          </Button>
          {mode === "size_limit" && onProceedAll && (
            <Button
              type="button"
              variant="secondary"
              disabled={!anyAction || listing}
              onClick={() => onProceedAll(actions)}
            >
              {t("sd.selector.proceedDespiteLimit")}
            </Button>
          )}
          <Button
            type="button"
            disabled={confirmDisabled}
            onClick={() => {
              if (catalogEmpty) {
                onConfirm([], {
                  backup: false,
                  import: false,
                  clear: false,
                  eject: true,
                  scanQr: false,
                });
                return;
              }
              onConfirm([...selected], actions);
            }}
          >
            {catalogEmpty && actions.eject
              ? t("app.sd.ejectLabel")
              : confirmLabel(actions, selected.size)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
