import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Checkbox } from "./ui/checkbox";
import {
  deleteProcessedFiles,
  listProcessedFiles,
  purgeProcessedFiles,
  type ProcessedFileEntry,
} from "../lib/sdCard";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type TypeFilter = "all" | "video" | "photo";
type PeriodFilter = "all" | "today" | "7d" | "30d" | "365d";

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function withinPeriod(iso: string | null, period: PeriodFilter): boolean {
  if (period === "all" || !iso) return period === "all";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  const day = 86400000;
  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return t >= d.getTime();
  }
  if (period === "7d") return now - t <= 7 * day;
  if (period === "30d") return now - t <= 30 * day;
  if (period === "365d") return now - t <= 365 * day;
  return true;
}

export function ProcessedFilesDialog({ open, onOpenChange }: Props) {
  const [entries, setEntries] = useState<ProcessedFileEntry[]>([]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  async function reload(q?: string) {
    setLoading(true);
    try {
      const rows = await listProcessedFiles(1000, q?.trim() || undefined);
      setEntries(rows);
      setSelected(new Set());
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void reload(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void reload(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (typeFilter !== "all" && e.media_type !== typeFilter) return false;
      const ref = e.imported_at || e.backed_up_at || e.first_seen_at;
      if (period !== "all" && !withinPeriod(ref, period)) return false;
      return true;
    });
  }, [entries, typeFilter, period]);

  const stats = useMemo(() => {
    const videos = filtered.filter((e) => e.media_type === "video").length;
    const photos = filtered.filter((e) => e.media_type === "photo").length;
    return `${filtered.length} Einträge (${videos} Videos, ${photos} Fotos)`;
  }, [filtered]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    await deleteProcessedFiles([...selected]);
    await reload(search);
  }

  async function purgeAll() {
    if (!window.confirm("Gesamte Medien-Historie löschen?")) return;
    await purgeProcessedFiles();
    await reload(search);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(950px,95vw)] max-w-none flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>Verarbeitete Dateien</DialogTitle>
          <DialogDescription>
            Hash-basierte Historie von Backup/Import (Duplikat-Erkennung).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 max-w-xs text-xs"
            placeholder="Suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle</SelectItem>
              <SelectItem value="video">Videos</SelectItem>
              <SelectItem value="photo">Fotos</SelectItem>
            </SelectContent>
          </Select>
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodFilter)}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Zeit</SelectItem>
              <SelectItem value="today">Heute</SelectItem>
              <SelectItem value="7d">Letzte 7 Tage</SelectItem>
              <SelectItem value="30d">Letzter Monat</SelectItem>
              <SelectItem value="365d">Letztes Jahr</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted">{loading ? "Laden…" : stats}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/60">
                <th className="w-8 p-2" />
                <th className="p-2">Dateiname</th>
                <th className="p-2">Typ</th>
                <th className="p-2">Größe</th>
                <th className="p-2">Importiert</th>
                <th className="p-2">Gesichert</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} className="border-b border-border/40 hover:bg-black/5">
                  <td className="p-2">
                    <Checkbox
                      checked={selected.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                    />
                  </td>
                  <td className="max-w-[260px] truncate p-2">{e.filename}</td>
                  <td className="p-2">{e.media_type}</td>
                  <td className="p-2">{formatBytes(e.size_bytes)}</td>
                  <td className="p-2">{e.imported_at ?? "—"}</td>
                  <td className="p-2">{e.backed_up_at ?? "—"}</td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted">
                    Keine Einträge
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button type="button" variant="destructive" size="sm" onClick={() => void purgeAll()}>
            Alles löschen
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => void removeSelected()}
          >
            Auswahl entfernen
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Schließen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
