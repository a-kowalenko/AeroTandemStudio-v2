import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
import { createSdThumbnailLoader } from "../lib/sdThumbnailLoader";
import {
  buildGridLayout,
  collectMarqueeHitsFromLayout,
  detailsRowHeight,
  filterAndSortFiles,
  formatBytes,
  GRID_PAD,
  gridColumnCount,
  MARQUEE_THRESHOLD_PX,
  OVERSCAN_ROWS,
  visibleGridEntries,
  type Density,
  type MediaFilter,
  type SortKey,
  type ViewMode,
} from "../lib/sdFileSelectorModel";
import { formatLocaleDateTime } from "@/lib/locale";
import { cn } from "../lib/utils";
import { useConfigStore } from "../store/configStore";
import { useKundeStore } from "../store/kundeStore";
import { useSdStore } from "../store/sdStore";
import { SdVideoTile } from "./SdVideoTile";
import { DateGroupHeader, SdDetailsRow, SdPhotoTile } from "./SdPhotoTile";
import {
  Check,
  Film,
  HardDrive,
  ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
} from "lucide-react";

type Props = {
  /** Defaults for action checkboxes (from settings). */
  defaultActions?: SdWorkflowActions;
  onClose: () => void;
  onConfirm: (selectedPaths: string[], actions: SdWorkflowActions) => void;
  onProceedAll?: (actions: SdWorkflowActions) => void;
  onRefresh?: () => void;
};

type SelectMode = "toggle" | "range";
type MarqueeMod = "replace" | "add" | "remove";

function formatEpoch(epoch: number): string {
  if (!epoch) return "—";
  return formatLocaleDateTime(new Date(epoch * 1000));
}

function formatCaptureTime(epoch: number): string {
  if (!epoch) return "";
  return formatLocaleDateTime(new Date(epoch * 1000));
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

function ActionToggle({
  pressed,
  disabled,
  title,
  onPressedChange,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  title?: string;
  onPressedChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "inline-flex h-8 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition",
        pressed
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border/70 bg-card text-muted hover:border-border hover:bg-card-elevated hover:text-foreground",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
          pressed
            ? "border-primary-foreground/80 bg-primary-foreground/20"
            : "border-muted-foreground/40",
        )}
        aria-hidden
      >
        {pressed ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      {children}
    </button>
  );
}

function CatalogStatusOverlay({
  listing,
  empty,
  filterEmpty,
  drive,
  reason,
  onRefresh,
}: {
  listing: boolean;
  empty: boolean;
  /** Catalog has files, but current filter/search matches none. */
  filterEmpty?: boolean;
  drive: string | null;
  reason: import("../lib/sdCard").ListEmptyReason | null;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  if (listing && empty) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
        <span className="inline-flex max-w-md items-center gap-2 text-center text-sm text-muted">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          {t("app.sd.readingFiles")}
        </span>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
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
  if (filterEmpty) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
        <p className="max-w-md text-center text-sm text-muted">
          {t("sd.selector.filterEmpty")}
        </p>
      </div>
    );
  }
  return null;
}

export function SdFileSelector({
  defaultActions,
  onClose,
  onConfirm,
  onProceedAll,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
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
  const [density, setDensity] = useState<Density>("comfortable");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [newOnly, setNewOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortAsc, setSortAsc] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [actions, setActions] = useState<SdWorkflowActions>({
    backup: true,
    import: true,
    clear: false,
    eject: false,
    scanQr: false,
  });
  const config = useConfigStore((s) => s.config);
  const formMode = useKundeStore((s) => s.kunde.form_mode);
  const [selectionDragging, setSelectionDragging] = useState(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
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
  const marqueeOverlayRef = useRef<HTMLDivElement | null>(null);
  const observedElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const ioRef = useRef<IntersectionObserver | null>(null);
  const loaderRef = useRef(createSdThumbnailLoader());
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
  const suppressClickRef = useRef(false);
  const dragBoxRef = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const shiftCheckboxRef = useRef(false);
  const wasEmptyCatalogRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const layoutTilesRef = useRef<
    ReturnType<typeof buildGridLayout>["tiles"]
  >([]);

  const attachGridRef = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    setGridEl((prev) => (prev === el ? prev : el));
  }, []);

  const attachDetailsRef = useCallback((el: HTMLDivElement | null) => {
    setDetailsEl((prev) => (prev === el ? prev : el));
  }, []);

  const paintMarqueeOverlay = useCallback(
    (box: { x0: number; y0: number; x1: number; y1: number } | null) => {
      const el = marqueeOverlayRef.current;
      if (!el) return;
      if (!box) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${Math.min(box.x0, box.x1)}px`;
      el.style.top = `${Math.min(box.y0, box.y1)}px`;
      el.style.width = `${Math.abs(box.x1 - box.x0)}px`;
      el.style.height = `${Math.abs(box.y1 - box.y0)}px`;
    },
    [],
  );

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
      setScrollLocked(true);
      if (scrollIdleTimerRef.current != null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        setScrollLocked(false);
      }, 140);
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
      if (scrollIdleTimerRef.current != null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
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

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  useEffect(() => {
    if (!open) setMoreOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    wasEmptyCatalogRef.current = false;
    setSelected(new Set());
    setActiveVideoPath(null);
    setSearchQuery("");
    anchorPathRef.current = null;
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    paintMarqueeOverlay(null);
    setSelectionDragging(false);
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
    const loader = loaderRef.current;
    if (!open) {
      loader.stop();
      return;
    }
    loader.start();
    return () => loader.stop();
  }, [open]);

  const filtered = useMemo(
    () =>
      filterAndSortFiles(
        files,
        mediaFilter,
        newOnly,
        sortKey,
        sortAsc,
        searchQuery,
      ),
    [files, mediaFilter, newOnly, sortKey, sortAsc, searchQuery],
  );

  const icaVirtual = isMtpDrive(drive);
  const groupByDate = sortKey === "date";
  const gridCols = gridColumnCount(gridMetrics.width, density);
  const gridLayout = useMemo(
    () =>
      buildGridLayout(filtered, {
        width: gridMetrics.width || 640,
        cols: gridCols,
        density,
        groupByDate,
      }),
    [filtered, gridMetrics.width, gridCols, density, groupByDate],
  );
  layoutTilesRef.current = gridLayout.tiles;

  const visibleEntries = useMemo(
    () =>
      visibleGridEntries(
        gridLayout,
        gridMetrics.scrollTop,
        gridMetrics.height || 400,
      ),
    [gridLayout, gridMetrics.scrollTop, gridMetrics.height],
  );

  const rowH = detailsRowHeight(density);
  const DETAILS_HEADER_H = 32;
  const detailsScrollInList = Math.max(
    0,
    detailsMetrics.scrollTop - DETAILS_HEADER_H,
  );
  const detailsStart = Math.max(
    0,
    Math.floor(detailsScrollInList / rowH) - OVERSCAN_ROWS * 2,
  );
  const detailsEnd = Math.min(
    filtered.length,
    Math.ceil((detailsScrollInList + detailsMetrics.height) / rowH) +
      OVERSCAN_ROWS * 2,
  );
  const visibleDetails = filtered.slice(detailsStart, detailsEnd);
  const detailsTotalH = filtered.length * rowH;

  const selectedStats = useMemo(() => {
    let videos = 0;
    let photos = 0;
    let bytes = 0;
    for (const f of files) {
      if (!selected.has(f.path)) continue;
      bytes += f.size_bytes;
      if (f.is_video) videos += 1;
      else photos += 1;
    }
    return {
      videos,
      photos,
      total: videos + photos,
      sizeMb: bytes / (1024 * 1024),
    };
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

  const newInFiltered = useMemo(
    () => filtered.filter((f) => !f.already_processed),
    [filtered],
  );

  const selectedInFilteredCount = useMemo(() => {
    let n = 0;
    for (const f of filtered) {
      if (selected.has(f.path)) n += 1;
    }
    return n;
  }, [filtered, selected]);

  const allFilteredSelected =
    filtered.length > 0 && selectedInFilteredCount === filtered.length;
  const allNewSelected =
    newInFiltered.length > 0 &&
    newInFiltered.every((f) => selected.has(f.path)) &&
    selected.size === newInFiltered.length;
  const noneSelected = selected.size === 0;

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

  const registerThumbEl = useCallback((path: string, el: HTMLElement | null) => {
    const prev = observedElsRef.current.get(path);
    const io = ioRef.current;
    if (prev && prev !== el && io) {
      io.unobserve(prev);
    }
    if (el) {
      observedElsRef.current.set(path, el);
      io?.observe(el);
    } else {
      observedElsRef.current.delete(path);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (listing && isMtpDrive(drive)) return;
    const root = viewMode === "thumbnail" ? gridEl : detailsEl;
    if (!root) return;

    const loader = loaderRef.current;
    const upgradeToHq = viewMode === "thumbnail" && !isMtpDrive(drive);
    const eagerCount = isMtpDrive(drive)
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
    ioRef.current = io;
    for (const el of observedElsRef.current.values()) {
      io.observe(el);
    }

    return () => {
      io.disconnect();
      if (ioRef.current === io) ioRef.current = null;
      loader.releaseAllVisible();
    };
  }, [open, viewMode, gridEl, detailsEl, drive, listing, filteredPathsKey]);

  const selectPath = useCallback(
    (path: string, mode: SelectMode) => {
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
    },
    [filtered],
  );

  const onTileSelect = useCallback(
    (path: string, shiftKey: boolean) => {
      selectPath(path, shiftKey ? "range" : "toggle");
    },
    [selectPath],
  );

  const onCheckboxPointerDown = useCallback(
    (path: string, e: React.PointerEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      shiftCheckboxRef.current = true;
      selectPath(path, "range");
    },
    [selectPath],
  );

  const onCheckboxCheckedChange = useCallback(
    (path: string) => {
      if (shiftCheckboxRef.current) {
        shiftCheckboxRef.current = false;
        return;
      }
      selectPath(path, "toggle");
    },
    [selectPath],
  );

  const onActivateVideo = useCallback((path: string) => {
    setActiveVideoPath(path);
  }, []);

  const onDeactivateVideo = useCallback((path: string) => {
    setActiveVideoPath((prev) => (prev === path ? null : prev));
  }, []);

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

  function invertSelection() {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const f of filtered) {
        if (!prev.has(f.path)) next.add(f.path);
      }
      return next;
    });
  }

  function toggleGroupSelection(paths: string[]) {
    setSelected((prev) => {
      const allOn = paths.length > 0 && paths.every((p) => prev.has(p));
      const next = new Set(prev);
      if (allOn) {
        for (const p of paths) next.delete(p);
      } else {
        for (const p of paths) next.add(p);
      }
      return next;
    });
    anchorPathRef.current = paths[paths.length - 1] ?? null;
  }

  function patchAction<K extends keyof SdWorkflowActions>(key: K, value: boolean) {
    setActions((prev) => {
      if (key === "backup" && !value) {
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
    // Empty chrome / group headers always; tiles only via data-marquee-ok.
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
        paintMarqueeOverlay(next);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    if (!dragBoxRef.current) return;
    const pt = gridLocalPoint(e);
    if (!pt) return;
    const next = { ...dragBoxRef.current, x1: pt.x, y1: pt.y };
    dragBoxRef.current = next;
    paintMarqueeOverlay(next);
  }

  function endMarqueeGesture(activeBox: typeof dragBoxRef.current) {
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    paintMarqueeOverlay(null);
    if (activeBox) {
      const hits = collectMarqueeHitsFromLayout(
        layoutTilesRef.current,
        activeBox,
      );
      commitMarquee(marqueeModRef.current, hits);
      setSelectionDragging(false);
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      return;
    }
    setSelectionDragging(false);
    suppressClickRef.current = false;
  }

  function onGridPointerUp() {
    endMarqueeGesture(dragBoxRef.current);
  }

  function onGridPointerCancel() {
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    paintMarqueeOverlay(null);
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

  const loader = loaderRef.current;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="flex h-[min(90vh,880px)] max-h-[90vh] w-[min(1100px,95vw)] max-w-none flex-col gap-2.5 overflow-hidden">
        <DialogHeader className="space-y-2 pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {locationLabel}
            {`, ${t("common.labels.filesCount", { count: files.length })}, ${totalSizeMb.toFixed(1)} MB`}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-card-elevated/80 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary ring-1 ring-primary/20">
                <HardDrive className="h-3.5 w-3.5" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight text-foreground">
                  {locationLabel}
                </p>
                <p className="text-[11px] tabular-nums text-muted">
                  {listing ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
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
                <span className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Film className="h-3 w-3" aria-hidden />
                  {mediaCounts.videos}
                </span>
              ) : null}
              {mediaCounts.photos > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                  <ImageIcon className="h-3 w-3" aria-hidden />
                  {mediaCounts.photos}
                </span>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex gap-0.5 rounded-md border border-border/60 p-0.5">
            <Button
              type="button"
              size="sm"
              variant={viewMode === "thumbnail" ? "default" : "ghost"}
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setViewMode("thumbnail")}
            >
              <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("sd.selector.viewTiles")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === "details" ? "default" : "ghost"}
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setViewMode("details")}
            >
              <List className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("sd.selector.viewDetails")}
            </Button>
          </div>
          <div className="flex gap-0.5 rounded-md border border-border/60 p-0.5">
            <Button
              type="button"
              size="sm"
              variant={density === "comfortable" ? "default" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={density === "comfortable"}
              onClick={() => setDensity("comfortable")}
            >
              {t("sd.selector.densityComfortable")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={density === "compact" ? "default" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={density === "compact"}
              onClick={() => setDensity("compact")}
            >
              {t("sd.selector.densityCompact")}
            </Button>
          </div>
          <div className="relative min-w-[10rem] flex-1 basis-[10rem]">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("sd.selector.searchPlaceholder")}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <div className="flex gap-0.5 rounded-md border border-border/60 p-0.5">
            {(
              [
                ["all", t("common.labels.all")],
                ["video", t("common.labels.videos")],
                ["photo", t("common.labels.photos")],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mediaFilter === value ? "default" : "ghost"}
                className="h-7 px-2 text-xs"
                aria-pressed={mediaFilter === value}
                onClick={() => setMediaFilter(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant={newOnly ? "default" : "secondary"}
            className="h-7 gap-1 px-2 text-xs"
            aria-pressed={newOnly}
            title={t("sd.selector.newOnlyHint")}
            onClick={() => setNewOnly((v) => !v)}
          >
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
                newOnly
                  ? "border-primary-foreground/80 bg-primary-foreground/20"
                  : "border-muted-foreground/40",
              )}
              aria-hidden
            >
              {newOnly ? <Check className="h-2.5 w-2.5" /> : null}
            </span>
            {t("common.filter.newOnly")}
          </Button>
          <Select
            value={`${sortKey}:${sortAsc ? "asc" : "desc"}`}
            onValueChange={(v) => {
              const [key, dir] = v.split(":") as [SortKey, "asc" | "desc"];
              setSortKey(key);
              setSortAsc(dir === "asc");
            }}
          >
            <SelectTrigger className="h-7 w-[13.5rem] shrink-0 overflow-hidden text-xs [&>span]:min-w-0 [&>span]:truncate [&>span]:whitespace-nowrap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date:desc" className="whitespace-nowrap">
                {t("sd.selector.sortDateNewest")}
              </SelectItem>
              <SelectItem value="date:asc" className="whitespace-nowrap">
                {t("sd.selector.sortDateOldest")}
              </SelectItem>
              <SelectItem value="name:asc" className="whitespace-nowrap">
                {t("sd.selector.sortNameAsc")}
              </SelectItem>
              <SelectItem value="name:desc" className="whitespace-nowrap">
                {t("sd.selector.sortNameDesc")}
              </SelectItem>
              <SelectItem value="size:desc" className="whitespace-nowrap">
                {t("sd.selector.sortSizeLargest")}
              </SelectItem>
              <SelectItem value="size:asc" className="whitespace-nowrap">
                {t("sd.selector.sortSizeSmallest")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 rounded-md border border-primary/25 bg-primary-soft/40 px-3 py-2 shadow-sm shadow-black/5">
          <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
            {t("sd.selector.selectionLabel")}
          </span>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={allFilteredSelected ? "default" : "secondary"}
              className={cn(
                "h-8 min-w-[4.5rem] px-3 text-xs font-semibold",
                !allFilteredSelected && "border-border bg-card shadow-sm",
              )}
              aria-pressed={allFilteredSelected}
              disabled={filtered.length === 0}
              onClick={selectAllFiltered}
            >
              {t("sd.selector.selectAllVisible")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={allNewSelected ? "default" : "secondary"}
              className={cn(
                "h-8 min-w-[4.5rem] px-3 text-xs font-semibold",
                !allNewSelected && "border-border bg-card shadow-sm",
              )}
              aria-pressed={allNewSelected}
              disabled={newInFiltered.length === 0}
              onClick={selectOnlyNew}
            >
              {t("sd.selector.selectNewOnly")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 min-w-[4.5rem] border-border bg-card px-3 text-xs font-semibold shadow-sm"
              disabled={noneSelected}
              onClick={clearSelection}
            >
              {t("sd.selector.clearSelection")}
            </Button>
          </div>
          <div className="relative" ref={moreRef}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 border-border bg-card px-2 shadow-sm"
              aria-label={t("sd.selector.moreActions")}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
            {moreOpen ? (
              <div
                role="menu"
                className="absolute top-full left-0 z-20 mt-1 min-w-[160px] rounded-md border border-border bg-card py-1 shadow-md"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full px-3 py-1.5 text-left text-xs hover:bg-black/5 disabled:opacity-50"
                  disabled={filtered.length === 0}
                  onClick={() => {
                    invertSelection();
                    setMoreOpen(false);
                  }}
                >
                  {t("sd.selector.invertSelection")}
                </button>
              </div>
            ) : null}
          </div>
          {selectedStats.total > 0 ? (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-card px-2.5 py-0.5 text-xs font-medium text-primary tabular-nums">
              {t("sd.selector.footerSelected", {
                count: selectedStats.total,
                sizeMb: selectedStats.sizeMb.toFixed(1),
              })}
              {selectedStats.videos > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-primary/90">
                  <Film className="h-3 w-3" aria-hidden />
                  {selectedStats.videos}
                </span>
              ) : null}
              {selectedStats.photos > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-primary/90">
                  <ImageIcon className="h-3 w-3" aria-hidden />
                  {selectedStats.photos}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="ml-auto text-[11px] text-muted">
              {t("sd.selector.footerNoneSelected")}
            </span>
          )}
        </div>

        {viewMode === "thumbnail" ? (
          <div
            ref={attachGridRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-card-elevated [scrollbar-gutter:stable]",
              selectionDragging && "select-none",
            )}
            onPointerDown={onGridPointerDown}
            onPointerMove={onGridPointerMove}
            onPointerUp={onGridPointerUp}
            onPointerCancel={onGridPointerCancel}
          >
            <div
              className="relative"
              style={{ height: Math.max(gridLayout.totalH, 1) }}
            >
              {/* Full-bleed gaps + dedicated side rails for marquee start. */}
              <div
                data-marquee-ok=""
                aria-hidden
                className="absolute inset-0 z-0"
              />
              <div
                data-marquee-ok=""
                aria-hidden
                className="absolute top-0 bottom-0 left-0 z-[2]"
                style={{ width: GRID_PAD }}
              />
              <div
                data-marquee-ok=""
                aria-hidden
                className="absolute top-0 right-0 bottom-0 z-[2]"
                style={{ width: GRID_PAD }}
              />
              {visibleEntries.map((entry) => {
                if (entry.kind === "header") {
                  const allOn =
                    entry.paths.length > 0 &&
                    entry.paths.every((p) => selected.has(p));
                  return (
                    <div
                      key={`h:${entry.key}`}
                      className="absolute right-0 left-0 z-[1]"
                      style={{
                        top: entry.y,
                        height: entry.height,
                        paddingLeft: GRID_PAD,
                        paddingRight: GRID_PAD,
                      }}
                    >
                      <DateGroupHeader
                        label={entry.label}
                        count={entry.count}
                        allSelected={allOn}
                        onSelectGroup={() => toggleGroupSelection(entry.paths)}
                        style={{ height: "100%" }}
                      />
                    </div>
                  );
                }

                const file = entry.file;
                const isSel = selected.has(file.path);
                const captureLabel = formatCaptureTime(file.display_epoch);
                const style = {
                  position: "absolute" as const,
                  left: entry.x,
                  top: entry.y,
                  width: entry.width,
                  height: entry.height,
                  zIndex: 1,
                };

                if (file.is_video && !icaVirtual) {
                  return (
                    <div key={file.path} style={style}>
                      <SdVideoTile
                        path={file.path}
                        filename={file.filename}
                        sizeLabel={formatBytes(file.size_bytes)}
                        captureLabel={captureLabel}
                        selected={isSel}
                        alreadyProcessed={file.already_processed}
                        showNewBadge={showNewBadges}
                        isActive={activeVideoPath === file.path}
                        selectionLocked={selectionDragging}
                        scrollLocked={scrollLocked}
                        previewEnabled={!icaVirtual}
                        density={density}
                        loader={loader}
                        onActivate={onActivateVideo}
                        onDeactivate={onDeactivateVideo}
                        onSelect={onTileSelect}
                        tileRef={registerThumbEl}
                      />
                    </div>
                  );
                }

                return (
                  <div key={file.path} style={style}>
                    <SdPhotoTile
                      path={file.path}
                      filename={file.filename}
                      sizeLabel={formatBytes(file.size_bytes)}
                      captureLabel={captureLabel}
                      isVideo={file.is_video}
                      selected={isSel}
                      alreadyProcessed={file.already_processed}
                      showNewBadge={showNewBadges}
                      density={density}
                      loader={loader}
                      onSelect={onTileSelect}
                      onCheckboxPointerDown={onCheckboxPointerDown}
                      onCheckboxCheckedChange={onCheckboxCheckedChange}
                      registerEl={registerThumbEl}
                    />
                  </div>
                );
              })}
              <div
                ref={marqueeOverlayRef}
                className="pointer-events-none absolute z-50 border border-primary bg-primary/25"
                style={{ display: "none" }}
              />
            </div>
            <CatalogStatusOverlay
              listing={listing}
              empty={files.length === 0}
              filterEmpty={files.length > 0 && filtered.length === 0}
              drive={drive}
              reason={emptyReason}
              onRefresh={onRefresh}
            />
          </div>
        ) : (
          <div
            ref={attachDetailsRef}
            className="relative min-h-0 flex-1 overflow-auto rounded-md border border-border/60"
          >
            <div
              className="sticky top-0 z-[1] grid items-center gap-2 border-b border-border/60 bg-card px-2 text-[11px] font-medium text-muted"
              style={{
                height: DETAILS_HEADER_H,
                gridTemplateColumns:
                  density === "compact"
                    ? "28px minmax(0,1fr) 64px 72px 120px"
                    : "32px 56px minmax(0,1fr) 72px 80px 140px",
              }}
            >
              <span />
              {density === "comfortable" ? (
                <span>{t("common.labels.preview")}</span>
              ) : null}
              <span>{t("common.labels.name")}</span>
              <span>{t("common.labels.type")}</span>
              <span>{t("common.labels.size")}</span>
              <span>{t("common.labels.date")}</span>
            </div>
            <div
              className="relative"
              style={{ height: Math.max(detailsTotalH, 1) }}
            >
              {visibleDetails.map((file, i) => {
                const idx = detailsStart + i;
                return (
                  <div
                    key={file.path}
                    className="absolute left-0 right-0"
                    style={{ top: idx * rowH, height: rowH }}
                  >
                    <SdDetailsRow
                      path={file.path}
                      filename={file.filename}
                      sizeLabel={formatBytes(file.size_bytes)}
                      dateLabel={formatEpoch(file.display_epoch)}
                      typeLabel={
                        file.is_video
                          ? t("common.labels.video")
                          : t("common.labels.photo")
                      }
                      selected={selected.has(file.path)}
                      alreadyProcessed={file.already_processed}
                      showNewBadge={showNewBadges}
                      density={density}
                      loader={loader}
                      onSelect={onTileSelect}
                      onCheckboxPointerDown={onCheckboxPointerDown}
                      onCheckboxCheckedChange={onCheckboxCheckedChange}
                      registerEl={registerThumbEl}
                    />
                  </div>
                );
              })}
            </div>
            <CatalogStatusOverlay
              listing={listing}
              empty={files.length === 0}
              filterEmpty={files.length > 0 && filtered.length === 0}
              drive={drive}
              reason={emptyReason}
              onRefresh={onRefresh}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card-elevated px-3 py-2">
          <span className="text-xs font-medium text-muted">
            {t("common.labels.actions")}:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <ActionToggle
              pressed={actions.backup}
              disabled={catalogEmpty}
              onPressedChange={(v) => patchAction("backup", v)}
            >
              {t("app.sd.backupLabel")}
            </ActionToggle>
            <ActionToggle
              pressed={actions.import}
              disabled={catalogEmpty}
              onPressedChange={(v) => patchAction("import", v)}
            >
              {t("app.import.label")}
            </ActionToggle>
            <ActionToggle
              pressed={actions.clear}
              disabled={!actions.backup || catalogEmpty}
              title={
                catalogEmpty
                  ? t("sd.selector.clearNoFiles")
                  : actions.backup
                    ? t("sd.selector.clearAfterBackup")
                    : t("sd.selector.clearNeedsBackup")
              }
              onPressedChange={(v) => patchAction("clear", v)}
            >
              {t("sd.selector.clearSd")}
            </ActionToggle>
            <ActionToggle
              pressed={actions.eject}
              title={t("sd.selector.ejectAfterBackupTitle")}
              onPressedChange={(v) => patchAction("eject", v)}
            >
              {t("app.sd.ejectLabel")}
            </ActionToggle>
            <ActionToggle
              pressed={Boolean(actions.scanQr)}
              disabled={!actions.import || catalogEmpty}
              title={
                actions.import
                  ? t("sd.selector.scanImportedQr")
                  : t("sd.selector.scanNeedsImport")
              }
              onPressedChange={(v) => patchAction("scanQr", v)}
            >
              {t("media.list.scanQr")}
            </ActionToggle>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {mode === "size_limit" && onProceedAll ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8"
                disabled={!anyAction || listing}
                onClick={() => onProceedAll(actions)}
              >
                {t("sd.selector.proceedDespiteLimit")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-8 min-w-[8rem]"
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
