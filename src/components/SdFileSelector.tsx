import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
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
import { getMediaThumbnail } from "../lib/sdCard";
import { cn } from "../lib/utils";
import { ProgressIndicator } from "./ProgressIndicator";
import { SdVideoTile } from "./SdVideoTile";

export type SdSelectorProgress = {
  percent: number;
  label?: string;
  detail?: string;
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
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
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
  /** At most one video tile may be actively previewing / playing. */
  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setThumbs({});
    setActiveVideoPath(null);
    setActions({
      backup: defaultActions?.backup ?? true,
      import: defaultActions?.import ?? true,
      // Clear only with backup
      clear: Boolean(defaultActions?.clear) && Boolean(defaultActions?.backup ?? true),
      eject: Boolean(defaultActions?.eject),
    });
    // Intentionally only when dialog opens or file list changes — not on every defaultActions identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files]);

  useEffect(() => {
    if (!open) setActiveVideoPath(null);
  }, [open]);

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

  // Lazy-load thumbnails for visible items (first 40)
  useEffect(() => {
    if (!open || viewMode !== "thumbnail") return;
    let cancelled = false;
    const batch = filtered.slice(0, 40);
    (async () => {
      for (const file of batch) {
        if (cancelled || thumbs[file.path]) continue;
        try {
          const res = await getMediaThumbnail(file.path);
          if (!cancelled) {
            setThumbs((prev) => ({ ...prev, [file.path]: res.data_url }));
          }
        } catch {
          // ignore missing thumbs
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewMode, filtered]);

  function toggle(path: string) {
    if (submitting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectAllFiltered() {
    if (submitting) return;
    setSelected(new Set(filtered.map((f) => f.path)));
  }

  function clearSelection() {
    if (submitting) return;
    setSelected(new Set());
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

  function onGridPointerDown(e: React.PointerEvent) {
    if (submitting || e.button !== 0 || viewMode !== "thumbnail") return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-tile]")) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (gridRef.current?.scrollLeft ?? 0);
    const y = e.clientY - rect.top + (gridRef.current?.scrollTop ?? 0);
    setDragBox({ x0: x, y0: y, x1: x, y1: y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGridPointerMove(e: React.PointerEvent) {
    if (!dragBox) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (gridRef.current?.scrollLeft ?? 0);
    const y = e.clientY - rect.top + (gridRef.current?.scrollTop ?? 0);
    setDragBox({ ...dragBox, x1: x, y1: y });
  }

  function onGridPointerUp() {
    if (!dragBox) return;
    const left = Math.min(dragBox.x0, dragBox.x1);
    const right = Math.max(dragBox.x0, dragBox.x1);
    const top = Math.min(dragBox.y0, dragBox.y1);
    const bottom = Math.max(dragBox.y0, dragBox.y1);
    if (right - left > 4 && bottom - top > 4) {
      const gridRect = gridRef.current?.getBoundingClientRect();
      const scrollLeft = gridRef.current?.scrollLeft ?? 0;
      const scrollTop = gridRef.current?.scrollTop ?? 0;
      const hit = new Set(selected);
      for (const [path, el] of tileRefs.current) {
        const r = el.getBoundingClientRect();
        if (!gridRect) continue;
        const tx = r.left - gridRect.left + scrollLeft;
        const ty = r.top - gridRect.top + scrollTop;
        const tw = r.width;
        const th = r.height;
        const overlaps =
          tx < right && tx + tw > left && ty < bottom && ty + th > top;
        if (overlaps) hit.add(path);
      }
      setSelected(hit);
    }
    setDragBox(null);
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
            ref={gridRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-card-elevated p-2",
              submitting && "pointer-events-none opacity-70",
            )}
            onPointerDown={onGridPointerDown}
            onPointerMove={onGridPointerMove}
            onPointerUp={onGridPointerUp}
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
                      thumbUrl={thumbs[file.path]}
                      selected={isSel}
                      alreadyProcessed={file.already_processed}
                      isActive={activeVideoPath === file.path}
                      onActivate={() => setActiveVideoPath(file.path)}
                      onDeactivate={() =>
                        setActiveVideoPath((prev) => (prev === file.path ? null : prev))
                      }
                      onToggleSelect={() => toggle(file.path)}
                      tileRef={setTileEl}
                    />
                  );
                }

                return (
                  <button
                    key={file.path}
                    type="button"
                    data-tile
                    ref={setTileEl}
                    onClick={() => toggle(file.path)}
                    className={cn(
                      "relative flex flex-col overflow-hidden rounded-md text-left transition",
                      isSel
                        ? "border-2 border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
                        : "border border-border/70",
                      file.already_processed && "opacity-70",
                    )}
                  >
                    <div className="relative flex aspect-video items-center justify-center bg-black/5">
                      <div
                        className="absolute top-1.5 left-1.5 z-10"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSel}
                          onCheckedChange={() => toggle(file.path)}
                          aria-label={`${file.filename} auswählen`}
                          className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
                        />
                      </div>
                      {thumbs[file.path] ? (
                        <img
                          src={thumbs[file.path]}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <ImageIcon className="h-8 w-8 text-muted" />
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
            className={cn(
              "min-h-0 flex-1 overflow-auto rounded-md border border-border/60",
              submitting && "pointer-events-none opacity-70",
            )}
          >
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/60">
                  <th className="w-8 p-2" />
                  <th className="p-2">Name</th>
                  <th className="p-2">Typ</th>
                  <th className="p-2">Größe</th>
                  <th className="p-2">Datum</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((file) => (
                  <tr
                    key={file.path}
                    className={cn(
                      "border-b border-border/40 hover:bg-black/5",
                      selected.has(file.path) && "bg-primary-soft",
                    )}
                    onClick={() => toggle(file.path)}
                  >
                    <td className="p-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(file.path)}
                        onCheckedChange={() => toggle(file.path)}
                      />
                    </td>
                    <td className="max-w-[280px] truncate p-2">{file.filename}</td>
                    <td className="p-2">{file.is_video ? "Video" : "Foto"}</td>
                    <td className="p-2">{formatBytes(file.size_bytes)}</td>
                    <td className="p-2">{formatEpoch(file.display_epoch)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {submitting && (
          <div className="shrink-0 space-y-2 border-t border-border/60 pt-3">
            <ProgressIndicator
              percent={progress?.percent ?? 0}
              label={progress?.label ?? "SD-Verarbeitung…"}
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
