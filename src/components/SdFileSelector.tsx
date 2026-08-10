import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { SdFileInfo, SdWorkflowActions } from "../lib/sdCard";
import {
  createSdThumbnailLoader,
  type ThumbState,
} from "../lib/sdThumbnailLoader";
import { cn } from "../lib/utils";
import { ProgressIndicator } from "./ProgressIndicator";
import { SdVideoTile } from "./SdVideoTile";

export type SdSelectorProgress = {
  percent: number;
  label?: string;
  detail?: string;
  /** True when no reliable percentage is available (import / waiting). */
  indeterminate?: boolean;
};

type Props = {
  open: boolean;
  drive: string | null;
  files: SdFileInfo[];
  totalSizeMb: number;
  mode: "backup" | "import" | "size_limit";
  /** Defaults for action checkboxes (from settings). */
  defaultActions?: SdWorkflowActions;
  /** True while backup/import runs after confirm — locks UI. */
  submitting?: boolean;
  /** Optional determinate progress (e.g. backup MB). */
  progress?: SdSelectorProgress | null;
  onClose: () => void;
  onConfirm: (selectedPaths: string[], actions: SdWorkflowActions) => void;
  onProceedAll?: (actions: SdWorkflowActions) => void;
};

type FilterType = "all" | "video" | "photo";
type SortKey = "date" | "name" | "size";
type ViewMode = "thumbnail" | "details";
type SelectMode = "toggle" | "range";
type MarqueeMod = "replace" | "add" | "remove";

const MARQUEE_THRESHOLD_PX = 7;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEpoch(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.toLocaleString("de-DE");
}

function confirmLabel(actions: SdWorkflowActions, count: number): string {
  const parts: string[] = [];
  if (actions.backup) parts.push("Backup");
  if (actions.import) parts.push("Import");
  if (actions.clear) parts.push("Bereinigen");
  if (actions.eject) parts.push("Auswerfen");
  if (parts.length === 0) return `Ausführen (${count})`;
  return `${parts.join(" · ")} (${count})`;
}

export function SdFileSelector({
  open,
  drive,
  files,
  totalSizeMb,
  mode,
  defaultActions,
  submitting = false,
  progress = null,
  onClose,
  onConfirm,
  onProceedAll,
}: Props) {
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
  });
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

  const attachGridRef = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    setGridEl((prev) => (prev === el ? prev : el));
  }, []);

  const attachDetailsRef = useCallback((el: HTMLDivElement | null) => {
    setDetailsEl((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setActiveVideoPath(null);
    anchorPathRef.current = null;
    pendingMarqueeRef.current = null;
    dragBoxRef.current = null;
    setDragBox(null);
    setSelectionDragging(false);
    setActions({
      backup: defaultActions?.backup ?? true,
      import: defaultActions?.import ?? true,
      // Clear only with backup
      clear: Boolean(defaultActions?.clear) && Boolean(defaultActions?.backup ?? true),
      eject: Boolean(defaultActions?.eject),
    });
    setThumbs(loaderRef.current.snapshotFor(files.map((f) => f.path)));
    // Intentionally only when dialog opens or file list changes — not on every defaultActions identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files]);

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
    let list = [...files];
    if (filterType === "video") list = list.filter((f) => f.is_video);
    if (filterType === "photo") list = list.filter((f) => !f.is_video);
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = a.display_epoch - b.display_epoch;
      else if (sortKey === "name") cmp = a.filename.localeCompare(b.filename, undefined, { numeric: true });
      else cmp = a.size_bytes - b.size_bytes;
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [files, filterType, sortKey, sortAsc]);

  const selectedSizeMb = useMemo(() => {
    let sum = 0;
    for (const f of files) {
      if (selected.has(f.path)) sum += f.size_bytes;
    }
    return sum / (1024 * 1024);
  }, [files, selected]);

  // Eager first page + IntersectionObserver for the rest (thumbnail grid + details rows).
  // Depend on scroll-root state so setup runs after Radix Presence mounts the root.
  useEffect(() => {
    if (!open) return;
    const root = viewMode === "thumbnail" ? gridEl : detailsEl;
    if (!root) return;

    const loader = loaderRef.current;
    const upgradeToHq = viewMode === "thumbnail";
    const eagerCount = viewMode === "thumbnail" ? 32 : 28;
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
  }, [open, viewMode, filtered, gridEl, detailsEl]);

  function selectPath(path: string, mode: SelectMode) {
    if (submitting) return;
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
    if (submitting) return;
    setSelected(new Set(filtered.map((f) => f.path)));
    anchorPathRef.current =
      filtered.length > 0 ? filtered[filtered.length - 1].path : null;
  }

  function clearSelection() {
    if (submitting) return;
    setSelected(new Set());
    anchorPathRef.current = null;
  }

  function patchAction<K extends keyof SdWorkflowActions>(key: K, value: boolean) {
    if (submitting) return;
    setActions((prev) => {
      if (key === "backup" && !value) {
        // Clear is only allowed together with backup.
        return { ...prev, backup: false, clear: false };
      }
      if (key === "clear" && value && !prev.backup) {
        return prev;
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

    const gridRect = gridRef.current?.getBoundingClientRect();
    if (!gridRect) return [];
    const scrollLeft = gridRef.current?.scrollLeft ?? 0;
    const scrollTop = gridRef.current?.scrollTop ?? 0;
    const hits: string[] = [];
    for (const [path, el] of tileRefs.current) {
      const r = el.getBoundingClientRect();
      const tx = r.left - gridRect.left + scrollLeft;
      const ty = r.top - gridRect.top + scrollTop;
      const overlaps =
        tx < right && tx + r.width > left && ty < bottom && ty + r.height > top;
      if (overlaps) hits.push(path);
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
    if (submitting || e.button !== 0 || viewMode !== "thumbnail") return;
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
      ? "Größen-Limit überschritten — Dateien wählen"
      : "SD-Karte — Dateien wählen";

  const anyAction = actions.backup || actions.import || actions.clear;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submitting) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] w-[min(1100px,95vw)] max-w-none flex-col gap-3 overflow-hidden"
        hideCloseButton={submitting}
        onPointerDownOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {drive ? `Laufwerk ${drive}` : "SD-Karte"} · {files.length} Dateien ·{" "}
            {totalSizeMb.toFixed(1)} MB gesamt
            {selected.size > 0 && ` · gewählt: ${selected.size} (${selectedSizeMb.toFixed(1)} MB)`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={viewMode === "thumbnail" ? "default" : "secondary"}
              disabled={submitting}
              onClick={() => setViewMode("thumbnail")}
            >
              Kacheln
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === "details" ? "default" : "secondary"}
              disabled={submitting}
              onClick={() => setViewMode("details")}
            >
              Details
            </Button>
          </div>
          <Select
            value={filterType}
            disabled={submitting}
            onValueChange={(v) => setFilterType(v as FilterType)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle</SelectItem>
              <SelectItem value="video">Videos</SelectItem>
              <SelectItem value="photo">Fotos</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortKey}
            disabled={submitting}
            onValueChange={(v) => setSortKey(v as SortKey)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Datum</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="size">Größe</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={submitting}
            onClick={() => setSortAsc((v) => !v)}
          >
            {sortAsc ? "↑ Auf" : "↓ Ab"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={submitting}
            onClick={selectAllFiltered}
          >
            Alle
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={clearSelection}
          >
            Keine
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border/60 bg-card-elevated px-3 py-2 text-sm">
          <span className="text-xs font-medium text-muted">Aktionen:</span>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={actions.backup}
              disabled={submitting}
              onCheckedChange={(v) => patchAction("backup", v === true)}
            />
            Backup
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={actions.import}
              disabled={submitting}
              onCheckedChange={(v) => patchAction("import", v === true)}
            />
            Import
          </label>
          <label
            className={cn(
              "flex items-center gap-2",
              !actions.backup && "opacity-50",
            )}
            title={
              actions.backup
                ? "SD-Karte nach erfolgreichem Backup leeren"
                : "Nur möglich, wenn Backup aktiviert ist"
            }
          >
            <Checkbox
              checked={actions.clear}
              disabled={submitting || !actions.backup}
              onCheckedChange={(v) => patchAction("clear", v === true)}
            />
            SD bereinigen
          </label>
          <label
            className="flex items-center gap-2"
            title="SD-Karte nach erfolgreichem Workflow sicher auswerfen"
          >
            <Checkbox
              checked={actions.eject}
              disabled={submitting}
              onCheckedChange={(v) => patchAction("eject", v === true)}
            />
            Auswerfen
          </label>
          {!actions.backup ? (
            <span className="text-[11px] text-muted">
              Bereinigen nur nach Backup möglich.
            </span>
          ) : null}
        </div>

        {viewMode === "thumbnail" ? (
          <div
            ref={attachGridRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-card-elevated p-2 pr-3 [scrollbar-gutter:stable]",
              submitting && "pointer-events-none opacity-70",
              selectionDragging && "select-none",
            )}
            onPointerDown={onGridPointerDown}
            onPointerMove={onGridPointerMove}
            onPointerUp={onGridPointerUp}
            onPointerCancel={onGridPointerCancel}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {filtered.map((file) => {
                const isSel = selected.has(file.path);
                const setTileEl = (el: HTMLElement | null) => {
                  if (el) tileRefs.current.set(file.path, el);
                  else tileRefs.current.delete(file.path);
                };

                if (file.is_video) {
                  return (
                    <SdVideoTile
                      key={file.path}
                      path={file.path}
                      filename={file.filename}
                      sizeLabel={formatBytes(file.size_bytes)}
                      thumbUrl={thumbs[file.path]?.url}
                      thumbQuality={thumbs[file.path]?.quality}
                      selected={isSel}
                      alreadyProcessed={file.already_processed}
                      isActive={activeVideoPath === file.path}
                      selectionLocked={selectionDragging}
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
                  <button
                    key={file.path}
                    type="button"
                    data-tile
                    data-marquee-ok=""
                    data-thumb-path={file.path}
                    ref={setTileEl}
                    onClick={(e) =>
                      selectPath(file.path, e.shiftKey ? "range" : "toggle")
                    }
                    className={cn(
                      "relative flex flex-col overflow-hidden rounded-md text-left transition",
                      isSel
                        ? "border-2 border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
                        : "border border-border/70",
                      file.already_processed && "opacity-70",
                    )}
                  >
                    <div className="relative flex aspect-video items-center justify-center bg-muted/40">
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
                          aria-label={`${file.filename} auswählen`}
                          className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
                        />
                      </div>
                      {thumbs[file.path]?.url ? (
                        <img
                          src={thumbs[file.path].url}
                          alt=""
                          className={cn(
                            "h-full w-full object-cover transition-[filter] duration-300",
                            thumbs[file.path].quality === "lq" && "blur-[0.5px] scale-[1.02]",
                          )}
                          draggable={false}
                        />
                      ) : (
                        <div className="h-full w-full animate-pulse bg-gradient-to-br from-muted/60 to-muted/20" />
                      )}
                    </div>
                    <div className="truncate px-2 py-1 text-[11px]">{file.filename}</div>
                    <div className="px-2 pb-1 text-[10px] text-muted">
                      {formatBytes(file.size_bytes)}
                      {file.already_processed ? " · bekannt" : ""}
                    </div>
                  </button>
                );
              })}
            </div>
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
            className={cn(
              "min-h-0 flex-1 overflow-auto rounded-md border border-border/60",
              submitting && "pointer-events-none opacity-70",
            )}
          >
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-[1] bg-card">
                <tr className="border-b border-border/60">
                  <th className="w-8 p-2" />
                  <th className="w-14 p-2">Vorschau</th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Typ</th>
                  <th className="p-2">Größe</th>
                  <th className="p-2">Datum</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((file) => {
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
                        <div
                          data-thumb-path={file.path}
                          className="h-9 w-14 overflow-hidden rounded bg-muted/40"
                        >
                          {thumb?.url ? (
                            <img
                              src={thumb.url}
                              alt=""
                              className="h-full w-full object-cover"
                              draggable={false}
                              decoding="async"
                            />
                          ) : (
                            <div className="h-full w-full animate-pulse bg-gradient-to-br from-muted/50 to-muted/20" />
                          )}
                        </div>
                      </td>
                      <td className="max-w-[280px] truncate p-2">{file.filename}</td>
                      <td className="p-2">{file.is_video ? "Video" : "Foto"}</td>
                      <td className="p-2">{formatBytes(file.size_bytes)}</td>
                      <td className="p-2">{formatEpoch(file.display_epoch)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {submitting && (
          <div className="shrink-0 space-y-2 border-t border-border/60 pt-3">
            <ProgressIndicator
              percent={progress?.percent ?? 0}
              label={progress?.label ?? "SD-Verarbeitung…"}
              indeterminate={Boolean(progress?.indeterminate)}
            />
            {progress?.detail ? (
              <p className="text-xs tabular-nums text-muted">{progress.detail}</p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
            Abbrechen
          </Button>
          {mode === "size_limit" && onProceedAll && (
            <Button
              type="button"
              variant="secondary"
              disabled={submitting || !anyAction}
              onClick={() => onProceedAll(actions)}
            >
              Alle trotzdem
            </Button>
          )}
          <Button
            type="button"
            disabled={submitting || selected.size === 0 || !anyAction}
            onClick={() => onConfirm([...selected], actions)}
          >
            {submitting ? "Läuft…" : confirmLabel(actions, selected.size)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
