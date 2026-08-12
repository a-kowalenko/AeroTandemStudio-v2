import { useEffect, useMemo, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  deleteProcessedFiles,
  listProcessedFiles,
  purgeProcessedFiles,
  type ProcessedFileEntry,
} from "../lib/sdCard";
import {
  deleteVorgaenge,
  listVorgangDateien,
  listVorgaenge,
  type VorgangEntry,
  type VorgangFileEntry,
} from "../lib/vorgangHistory";
import { QrSpotlightPreview } from "@/components/QrSpotlightPreview";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type TypeFilter = "all" | "video" | "photo";
type PeriodFilter = "all" | "today" | "7d" | "30d" | "365d";

type PendingConfirm = {
  title: string;
  description: string;
  actionLabel: string;
  run: () => Promise<void>;
};

function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * History rows were stored as UTC wall clock without a timezone marker.
 * Treat missing offset/Z as UTC so display and filters match local time.
 */
function parseHistoryIso(iso: string): number {
  const s = iso.trim();
  if (!s) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  return Date.parse(hasZone ? s : `${s}Z`);
}

function withinPeriod(iso: string | null, period: PeriodFilter): boolean {
  if (period === "all" || !iso) return period === "all";
  const t = parseHistoryIso(iso);
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

function productBadges(v: VorgangEntry): string[] {
  const badges: string[] = [];
  if (v.handcam_video) badges.push(v.ist_bezahlt_handcam_video ? "HV✓" : "HV");
  if (v.handcam_foto) badges.push(v.ist_bezahlt_handcam_foto ? "HF✓" : "HF");
  if (v.outside_video) badges.push(v.ist_bezahlt_outside_video ? "OV✓" : "OV");
  if (v.outside_foto) badges.push(v.ist_bezahlt_outside_foto ? "OF✓" : "OF");
  return badges;
}

function roleLabel(role: string): string {
  switch (role) {
    case "source_video":
      return "Quelle Video";
    case "source_photo":
      return "Quelle Foto";
    case "output_video":
      return "Ausgabe Video";
    case "wm_video":
      return "WM Video";
    case "marker":
      return "Marker";
    default:
      return role;
  }
}

function formatCreatedAt(iso: string): string {
  const t = parseHistoryIso(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function entryModeLabel(formMode: string, manualEntryMode: string): string | null {
  const form = formMode.trim().toLowerCase();
  if (form === "kunde") return "QR";
  if (form !== "manual") {
    return form ? formMode.trim() : null;
  }
  switch (manualEntryMode.trim().toLowerCase()) {
    case "id":
      return "Manuell · ID";
    case "oldschool":
      return "Manuell · Kontakt";
    case "lokal":
      return "Manuell · Lokal";
    default:
      return "Manuell";
  }
}

/** @deprecated Prefer HistoryDialog — kept for existing imports. */
export function ProcessedFilesDialog(props: Props) {
  return <HistoryDialog {...props} />;
}

export function HistoryDialog({ open, onOpenChange }: Props) {
  const [tab, setTab] = useState<"vorgaenge" | "medien">("vorgaenge");
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmOpen = pendingConfirm != null;

  async function runConfirm() {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await pendingConfirm.run();
      setPendingConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) setPendingConfirm(null);
          onOpenChange(v);
        }}
      >
        <DialogContent
          className="!flex h-[min(85vh,640px)] w-[min(1100px,96vw)] max-w-none flex-col gap-3 overflow-hidden"
          onPointerDownOutside={(e) => {
            if (confirmOpen) e.preventDefault();
          }}
          onFocusOutside={(e) => {
            if (confirmOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (confirmOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (confirmOpen) e.preventDefault();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>Historie</DialogTitle>
            <DialogDescription>
              Erstellte Vorgänge und Medien-Historie (Duplikat-Erkennung).
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "vorgaenge" | "medien")}
            className="flex min-h-0 flex-1 flex-col gap-3"
          >
            <TabsList className="h-9 w-fit shrink-0">
              <TabsTrigger value="vorgaenge" className="text-xs">
                Vorgänge
              </TabsTrigger>
              <TabsTrigger value="medien" className="text-xs">
                Medien
              </TabsTrigger>
            </TabsList>

            <div className="relative min-h-0 flex-1">
              <TabsContent
                value="vorgaenge"
                forceMount
                className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
              >
                <VorgaengePanel
                  dialogOpen={open}
                  onRequestConfirm={setPendingConfirm}
                />
              </TabsContent>
              <TabsContent
                value="medien"
                forceMount
                className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
              >
                <MedienPanel
                  dialogOpen={open}
                  onRequestConfirm={setPendingConfirm}
                />
              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter className="shrink-0">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Schließen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!v && !confirmBusy) setPendingConfirm(null);
        }}
      >
        <DialogContent
          className="z-[60] max-w-md border-l-4 border-l-destructive"
          overlayClassName="z-[60]"
        >
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {pendingConfirm?.title}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {pendingConfirm?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={confirmBusy}
              onClick={() => setPendingConfirm(null)}
            >
              Abbrechen
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={confirmBusy}
              onClick={() => void runConfirm()}
            >
              {pendingConfirm?.actionLabel ?? "Löschen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function VorgaengePanel({
  dialogOpen,
  onRequestConfirm,
}: {
  dialogOpen: boolean;
  onRequestConfirm: (pending: PendingConfirm) => void;
}) {
  const [entries, setEntries] = useState<VorgangEntry[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [files, setFiles] = useState<VorgangFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [filesReady, setFilesReady] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const searchRef = useRef(search);
  searchRef.current = search;

  async function reload(q?: string) {
    setLoading(true);
    try {
      const rows = await listVorgaenge(500, q?.trim() || undefined);
      setEntries(rows);
      setChecked(new Set());
      setSelectedId((prev) => {
        if (prev != null && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch {
      setEntries([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  useEffect(() => {
    if (!dialogOpen) return;
    void reload(searchRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen || !ready) return;
    const t = setTimeout(() => void reload(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (!dialogOpen) return;
    if (selectedId == null) {
      setFiles([]);
      setFilesReady(true);
      return;
    }
    let cancelled = false;
    setFilesReady(false);
    void listVorgangDateien(selectedId)
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setFilesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, selectedId]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );
  const selectedMode = selected
    ? entryModeLabel(selected.form_mode, selected.manual_entry_mode)
    : null;

  function toggleCheck(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestRemoveSelected() {
    if (checked.size === 0) return;
    const ids = [...checked];
    const n = ids.length;
    onRequestConfirm({
      title:
        n === 1
          ? "Vorgang aus der Historie entfernen?"
          : `${n} Vorgänge aus der Historie entfernen?`,
      description:
        n === 1
          ? "Der ausgewählte Vorgang wird aus der Historie gelöscht. Dateien auf dem Speicherort bleiben erhalten; ein zugehöriger QR-Scan-Frame der App wird mit entfernt."
          : "Die ausgewählten Vorgänge werden aus der Historie gelöscht. Dateien auf dem Speicherort bleiben erhalten; zugehörige QR-Scan-Frames der App werden mit entfernt.",
      actionLabel: "Entfernen",
      run: async () => {
        await deleteVorgaenge(ids);
        await reload(search);
      },
    });
  }

  const showEmptyList = ready && !loading && entries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex h-8 shrink-0 flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-xs text-xs"
          placeholder="Gast, ID, Dateiname…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="ml-auto min-w-[7rem] text-right text-xs text-muted tabular-nums">
          {!ready || loading ? "Laden…" : `${entries.length} Vorgänge`}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={checked.size === 0}
          onClick={requestRemoveSelected}
        >
          Auswahl entfernen
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="min-h-0 overflow-y-auto overflow-x-hidden rounded-md border border-border/60">
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col className="w-8" />
              <col className="w-[28%]" />
              <col className="w-[18%]" />
              <col className="w-[22%]" />
              <col className="w-[28%]" />
            </colgroup>
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/60">
                <th className="p-2" />
                <th className="p-2">Gast</th>
                <th className="p-2">Datum</th>
                <th className="p-2">Produkte</th>
                <th className="p-2">Erstellt</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const badges = productBadges(e);
                return (
                  <tr
                    key={e.id}
                    className={cn(
                      "cursor-pointer border-b border-border/40 hover:bg-black/5",
                      selectedId === e.id && "bg-black/8",
                    )}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <td className="p-2" onClick={(ev) => ev.stopPropagation()}>
                      <Checkbox
                        checked={checked.has(e.id)}
                        onCheckedChange={() => toggleCheck(e.id)}
                      />
                    </td>
                    <td className="truncate p-2 font-medium" title={e.gast}>
                      {e.gast}
                    </td>
                    <td className="truncate p-2" title={e.datum || undefined}>
                      {e.datum || "—"}
                    </td>
                    <td className="p-2">
                      {badges.length === 0 ? (
                        "—"
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {badges.map((b) => (
                            <span
                              key={b}
                              className="rounded border border-border/60 px-1 py-0.5 text-[10px]"
                            >
                              {b}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td
                      className="truncate p-2 text-muted"
                      title={formatCreatedAt(e.created_at)}
                    >
                      {formatCreatedAt(e.created_at)}
                    </td>
                  </tr>
                );
              })}
              {showEmptyList && (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted">
                    Noch keine Vorgänge. Nach dem Erstellen erscheinen sie hier.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border border-border/60 p-2">
          {selected ? (
            <>
              <div className="shrink-0 space-y-1 border-b border-border/40 pb-2 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium">{selected.gast}</span>
                  {selectedMode && <span className="text-muted">· {selectedMode}</span>}
                </div>
                <div className="text-muted">
                  {[
                    selected.ort,
                    selected.tandemmaster && `TA: ${selected.tandemmaster}`,
                    selected.videospringer && `V: ${selected.videospringer}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
                <div className="truncate text-muted" title={selected.base_output_dir}>
                  {selected.base_filename}
                  {selected.encoder ? ` · ${selected.encoder}` : ""}
                  {selected.reused_preview ? " · Preview-Reuse" : ""}
                </div>
                {(selected.kunden_id || selected.booking_id) && (
                  <div className="text-muted">
                    {[
                      selected.kunden_id && `Kunde: ${selected.kunden_id}`,
                      selected.booking_id && `Booking: ${selected.booking_id}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {selected.qr_preview?.path?.trim() ? (
                  <div className="mb-2 shrink-0 border-b border-border/40 pb-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
                      QR-Scan-Frame
                    </div>
                    <QrSpotlightPreview
                      key={selected.qr_preview.path}
                      preview={selected.qr_preview}
                      className="max-h-[min(28vh,14rem)]"
                    />
                  </div>
                ) : null}
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border/60">
                      <th className="p-2">Name</th>
                      <th className="p-2">Typ</th>
                      <th className="p-2">Rolle</th>
                      <th className="p-2">Größe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.id} className="border-b border-border/40">
                        <td
                          className="max-w-[220px] truncate p-2"
                          title={f.path ?? f.filename}
                        >
                          {f.filename}
                        </td>
                        <td className="p-2">{f.media_type}</td>
                        <td className="p-2">{roleLabel(f.role)}</td>
                        <td className="p-2">{formatBytes(f.size_bytes)}</td>
                      </tr>
                    ))}
                    {filesReady && files.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-4 text-center text-muted">
                          Keine Dateien
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : ready ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              Vorgang auswählen
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MedienPanel({
  dialogOpen,
  onRequestConfirm,
}: {
  dialogOpen: boolean;
  onRequestConfirm: (pending: PendingConfirm) => void;
}) {
  const [entries, setEntries] = useState<ProcessedFileEntry[]>([]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const searchRef = useRef(search);
  searchRef.current = search;

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
      setReady(true);
    }
  }

  useEffect(() => {
    if (!dialogOpen) return;
    void reload(searchRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen || !ready) return;
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

  function requestRemoveSelected() {
    if (selected.size === 0) return;
    const ids = [...selected];
    const n = ids.length;
    onRequestConfirm({
      title:
        n === 1
          ? "Medien-Eintrag aus der Historie entfernen?"
          : `${n} Medien-Einträge aus der Historie entfernen?`,
      description:
        n === 1
          ? "Der Eintrag wird aus der Medien-Historie gelöscht. Die Datei selbst bleibt erhalten."
          : "Die Einträge werden aus der Medien-Historie gelöscht. Die Dateien selbst bleiben erhalten.",
      actionLabel: "Entfernen",
      run: async () => {
        await deleteProcessedFiles(ids);
        await reload(search);
      },
    });
  }

  function requestPurgeAll() {
    onRequestConfirm({
      title: "Gesamte Medien-Historie löschen?",
      description:
        "Alle Einträge der Medien-Historie (Duplikat-Erkennung) werden entfernt. Die Dateien selbst bleiben erhalten.",
      actionLabel: "Alles löschen",
      run: async () => {
        await purgeProcessedFiles();
        await reload(search);
      },
    });
  }

  const showEmpty = ready && !loading && filtered.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex h-8 shrink-0 flex-wrap items-center gap-2">
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
        <span className="ml-auto min-w-[12rem] text-right text-xs text-muted tabular-nums">
          {!ready || loading ? "Laden…" : stats}
        </span>
        <Button type="button" variant="destructive" size="sm" onClick={requestPurgeAll}>
          Alles löschen
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selected.size === 0}
          onClick={requestRemoveSelected}
        >
          Auswahl entfernen
        </Button>
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
                <td className="p-2">
                  {e.imported_at ? formatCreatedAt(e.imported_at) : "—"}
                </td>
                <td className="p-2">
                  {e.backed_up_at ? formatCreatedAt(e.backed_up_at) : "—"}
                </td>
              </tr>
            ))}
            {showEmpty && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-muted">
                  Keine Einträge
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
