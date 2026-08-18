import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FolderOpen, Images, Upload } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  type AppendCategoryId,
  type AppendMediaItem,
  type VorgangEntry,
} from "../lib/vorgangHistory";
import { amsBridgeHealth } from "../lib/tauri";
import { getMediaThumbnail } from "../lib/sdCard";
import {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  mediaKind,
} from "../lib/media";
import { expandMediaPaths } from "../lib/tauri";
import { useAppendStore } from "@/store/appendStore";

type Props = {
  open: boolean;
  vorgang: VorgangEntry | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (items: AppendMediaItem[]) => void;
  /** While the native file picker is open (parent dialogs must stay open). */
  onPickingFilesChange?: (picking: boolean) => void;
};

type DraftItem = AppendMediaItem & {
  name: string;
  thumb?: string;
};

type CatDef = {
  id: AppendCategoryId;
  label: string;
  short: string;
  video: boolean;
  booked: (v: VorgangEntry) => boolean;
  paid: (v: VorgangEntry) => boolean;
};

const CATS: CatDef[] = [
  {
    id: "handcam_video",
    label: "Handcam Video",
    short: "HV",
    video: true,
    booked: (v) => v.handcam_video,
    paid: (v) => v.ist_bezahlt_handcam_video,
  },
  {
    id: "handcam_foto",
    label: "Handcam Foto",
    short: "HF",
    video: false,
    booked: (v) => v.handcam_foto,
    paid: (v) => v.ist_bezahlt_handcam_foto,
  },
  {
    id: "outside_video",
    label: "Outside Video",
    short: "OV",
    video: true,
    booked: (v) => v.outside_video,
    paid: (v) => v.ist_bezahlt_outside_video,
  },
  {
    id: "outside_foto",
    label: "Outside Foto",
    short: "OF",
    video: false,
    booked: (v) => v.outside_foto,
    paid: (v) => v.ist_bezahlt_outside_foto,
  },
];

function basename(path: string): string {
  const n = path.replace(/\\/g, "/").split("/").pop();
  return n || path;
}

function catDef(id: AppendCategoryId): CatDef | undefined {
  return CATS.find((c) => c.id === id);
}

function categoryNotPaid(v: VorgangEntry, id: AppendCategoryId): boolean {
  const c = catDef(id);
  if (!c) return false;
  return !c.booked(v) || !c.paid(v);
}

function defaultPreviewForCategory(v: VorgangEntry, id: AppendCategoryId): boolean {
  return categoryNotPaid(v, id);
}

function itemModeLabel(
  v: VorgangEntry,
  item: DraftItem,
): string {
  const c = catDef(item.category);
  if (!c) return item.preview ? "Original + Preview" : "Original";
  if (c.booked(v) && c.paid(v)) return "Original";
  if (item.preview) return "Original + Preview";
  return "Original";
}

export function AppendMediaDialog({
  open,
  vorgang,
  onOpenChange,
  onSubmit,
  onPickingFilesChange,
}: Props) {
  const [category, setCategory] = useState<AppendCategoryId>("handcam_foto");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capWarning, setCapWarning] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const submittingRef = useRef(false);
  const setCaptureFileDrop = useAppendStore((s) => s.setCaptureFileDrop);

  const activeCat = useMemo(
    () => (vorgang ? catDef(category) : undefined),
    [vorgang, category],
  );
  const categoryBooked = Boolean(activeCat && vorgang && activeCat.booked(vorgang));
  const categoryNotPaidActive = Boolean(
    vorgang && categoryNotPaid(vorgang, category),
  );

  useEffect(() => {
    if (!open || !vorgang) return;
    const firstBooked = CATS.find((c) => c.booked(vorgang));
    const next = firstBooked?.id ?? "handcam_video";
    setCategory(next);
    setItems([]);
    setError(null);
    setBusy(false);
    setCapWarning(null);
    setDragOver(false);
    submittingRef.current = false;
    void amsBridgeHealth()
      .then((h) => {
        if (h.ok && h.health && !h.health.capabilities.includes("append-v1")) {
          setCapWarning(
            "AMS kennt Nachreichen noch nicht (append-v1 fehlt). Bitte AMS aktualisieren, sonst entsteht ein neuer Cloud-Ordner.",
          );
        }
      })
      .catch(() => {
        /* Datei-Handoff bleibt Fallback */
      });
  }, [open, vorgang?.id]);

  const ingestPaths = useCallback(
    async (rawPaths: string[]) => {
      if (!vorgang || busy || submittingRef.current) return;
      const cat = catDef(category);
      if (!cat || rawPaths.length === 0) return;

      let expanded: string[];
      try {
        expanded = await expandMediaPaths(rawPaths);
      } catch (e) {
        setError(String(e));
        return;
      }

      const previewDefault = defaultPreviewForCategory(vorgang, category);

      let added: DraftItem[] = [];
      let skippedKind = 0;
      setItems((prev) => {
        const known = new Set(prev.map((p) => p.path));
        const batch: DraftItem[] = [];
        skippedKind = 0;
        for (const path of expanded) {
          if (known.has(path)) continue;
          const kind = mediaKind(path);
          if (cat.video && kind !== "video") {
            skippedKind += 1;
            continue;
          }
          if (!cat.video && kind !== "photo") {
            skippedKind += 1;
            continue;
          }
          known.add(path);
          batch.push({
            path,
            category,
            preview: previewDefault,
            name: basename(path),
          });
        }
        added = batch;
        return batch.length === 0 ? prev : [...prev, ...batch];
      });

      if (added.length === 0) {
        if (expanded.length === 0) {
          setError(
            cat.video
              ? "Keine unterstützten Videos gefunden."
              : "Keine unterstützten Fotos gefunden.",
          );
        } else if (skippedKind > 0) {
          setError(
            cat.video
              ? "Bitte Videos ablegen (aktuelle Kategorie ist Video)."
              : "Bitte Fotos ablegen (aktuelle Kategorie ist Foto).",
          );
        }
        return;
      }
      setError(null);
      for (const item of added) {
        void getMediaThumbnail(item.path, "lq")
          .then((t) => {
            setItems((prev) =>
              prev.map((p) =>
                p.path === item.path ? { ...p, thumb: t.data_url } : p,
              ),
            );
          })
          .catch(() => {
            /* no thumb */
          });
      }
    },
    [vorgang, busy, category],
  );

  useEffect(() => {
    if (!open) {
      setCaptureFileDrop(false);
      setDragOver(false);
      return;
    }
    setCaptureFileDrop(true);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (busy || submittingRef.current) {
            setDragOver(false);
            return;
          }
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            void ingestPaths(event.payload.paths);
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch(() => {
          /* not running inside Tauri webview */
        });
    } catch {
      /* browser preview */
    }
    return () => {
      cancelled = true;
      setCaptureFileDrop(false);
      setDragOver(false);
      unlisten?.();
    };
  }, [open, busy, ingestPaths, setCaptureFileDrop]);

  async function addFiles() {
    if (!vorgang) return;
    const cat = catDef(category);
    if (!cat) return;
    let selected: string | string[] | null;
    onPickingFilesChange?.(true);
    try {
      selected = await openDialog({
        title: cat.video ? "Videos wählen" : "Fotos wählen",
        multiple: true,
        filters: [
          {
            name: cat.video ? "Video" : "Fotos",
            extensions: [
              ...(cat.video ? VIDEO_EXTENSIONS : PHOTO_EXTENSIONS),
            ],
          },
        ],
      });
    } catch (e) {
      setError(String(e));
      return;
    } finally {
      onPickingFilesChange?.(false);
    }
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    await ingestPaths(paths);
  }

  async function addFolder() {
    if (!vorgang) return;
    let selected: string | string[] | null;
    onPickingFilesChange?.(true);
    try {
      selected = await openDialog({
        title: "Ordner wählen",
        directory: true,
        multiple: false,
      });
    } catch (e) {
      setError(String(e));
      return;
    } finally {
      onPickingFilesChange?.(false);
    }
    if (typeof selected === "string" && selected) {
      await ingestPaths([selected]);
    }
  }

  function removeItem(path: string) {
    setItems((prev) => prev.filter((i) => i.path !== path));
  }

  function toggleItemPreview(path: string, checked: boolean) {
    setItems((prev) =>
      prev.map((i) => (i.path === path ? { ...i, preview: checked } : i)),
    );
  }

  async function submit() {
    if (!vorgang || items.length === 0 || busy) return;

    const notPaidPhotos = items.filter(
      (i) => categoryNotPaid(vorgang, i.category) && !catDef(i.category)?.video,
    );
    if (
      notPaidPhotos.length > 0 &&
      !notPaidPhotos.some((i) => i.preview)
    ) {
      setError(
        "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.",
      );
      return;
    }

    const notPaidVideos = items.filter(
      (i) => categoryNotPaid(vorgang, i.category) && catDef(i.category)?.video,
    );
    if (
      notPaidVideos.length > 0 &&
      !notPaidVideos.some((i) => i.preview)
    ) {
      setError(
        "Video-Produkt ist nicht bezahlt — bitte mindestens ein Video für die Preview auswählen.",
      );
      return;
    }

    setBusy(true);
    setError(null);
    submittingRef.current = true;

    const payload: AppendMediaItem[] = items.map(({ path, category, preview }) => ({
      path,
      category,
      preview,
    }));

    onOpenChange(false);
    onSubmit(payload);
    setBusy(false);
    submittingRef.current = false;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="z-[60] flex max-h-[min(44rem,calc(100vh-2rem))] max-w-lg flex-col gap-3"
        overlayClassName="z-[60]"
        onFocusOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (busy || submittingRef.current) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Medien nachreichen</DialogTitle>
          <DialogDescription>
            {vorgang
              ? `Zusätzliche Dateien für ${vorgang.gast} in den bestehenden Kundenordner. Der Download-Link bleibt.`
              : "Vorgang wählen."}
          </DialogDescription>
        </DialogHeader>

        {capWarning ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-950 dark:text-amber-100">
            {capWarning}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-1">
          {CATS.map((c) => {
            const isBooked = vorgang ? c.booked(vorgang) : false;
            const isUnpaid = vorgang ? c.booked(vorgang) && !c.paid(vorgang) : false;
            const active = category === c.id;
            return (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => setCategory(c.id)}
                className={cn(
                  "inline-flex h-7 items-center rounded border px-2 text-[11px] font-medium",
                  active
                    ? "border-primary/50 bg-primary/15 text-foreground"
                    : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40",
                )}
                title={
                  !isBooked
                    ? `${c.label} (nicht gebucht)`
                    : isUnpaid
                      ? `${c.label} (nicht bezahlt)`
                      : c.label
                }
              >
                {c.short}
                {!isBooked ? (
                  <span className="ml-1 text-[9px] opacity-70">neu</span>
                ) : isUnpaid ? (
                  <span className="ml-1 text-[9px] opacity-70">offen</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {categoryNotPaidActive ? (
          <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Option ist nicht bezahlt: Originale werden hochgeladen. Pro Datei kann
            zusätzlich eine Preview mit Wasserzeichen erzeugt werden — wie beim
            Erstellen.
          </p>
        ) : categoryBooked ? (
          <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Gebuchte und bezahlte Option — Dateien werden als Original
            nachgereicht.
          </p>
        ) : null}

        <div
          className={cn(
            "relative shrink-0 overflow-hidden rounded-xl border-2 border-dashed px-3 py-3 text-center transition-[border-color,background-color,box-shadow,transform] duration-200",
            dragOver
              ? "scale-[1.01] border-primary bg-primary-soft shadow-[inset_0_0_0_1px] shadow-primary/30"
              : "border-border bg-card-elevated/60 hover:border-primary/40 hover:bg-card-elevated",
            busy && "pointer-events-none opacity-60",
          )}
          role="region"
          aria-label={
            activeCat?.video
              ? "Videos oder Ordner hierher ziehen"
              : "Fotos oder Ordner hierher ziehen"
          }
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200",
              dragOver && "opacity-100",
            )}
            aria-hidden
          >
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--ats-primary-soft),transparent_70%)]" />
          </div>
          <div className="relative">
            <div className="mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary ring-1 ring-primary/15">
              {dragOver ? (
                <Upload className="h-4 w-4 animate-pulse" aria-hidden />
              ) : (
                <Images className="h-4 w-4" aria-hidden />
              )}
            </div>
            <p className="mb-0.5 text-xs font-medium text-foreground">
              {dragOver
                ? "Loslassen zum Hinzufügen"
                : activeCat?.video
                  ? "Videos oder Ordner hierher ziehen"
                  : "Fotos oder Ordner hierher ziehen"}
            </p>
            <p className="mb-2 text-[11px] text-muted">
              {activeCat?.video
                ? "Ordner rekursiv · .mp4, .mov …"
                : "Ordner rekursiv · .jpg, .png, .webp …"}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void addFiles()}
              >
                Dateien wählen…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void addFolder()}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Ordner wählen…
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end">
          <span className="text-xs text-muted-foreground">
            {items.length === 0
              ? "Noch keine Dateien"
              : `${items.length} Datei(en)`}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/50">
          {items.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              Fotos oder Videos wählen und einer Kategorie zuordnen. Bei
              unbezahlten Optionen pro Datei Preview markieren; Originale gehen
              immer mit hoch.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {items.map((item) => {
                const showPreviewToggle =
                  vorgang != null && categoryNotPaid(vorgang, item.category);
                return (
                  <li
                    key={item.path}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs"
                  >
                    {item.thumb ? (
                      <img
                        src={item.thumb}
                        alt=""
                        className="size-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="size-10 shrink-0 rounded bg-muted/50" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={item.path}>
                        {item.name}
                      </div>
                      <div className="text-muted-foreground">
                        {catDef(item.category)?.short}
                        {" · "}
                        {vorgang ? itemModeLabel(vorgang, item) : "—"}
                      </div>
                    </div>
                    {showPreviewToggle ? (
                      <label
                        className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
                        title="Zusätzliche Preview mit Wasserzeichen"
                      >
                        <Checkbox
                          checked={item.preview}
                          disabled={busy}
                          onCheckedChange={(v) =>
                            toggleItemPreview(item.path, v === true)
                          }
                        />
                        Preview
                      </label>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() => removeItem(item.path)}
                    >
                      Entf.
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Abbrechen
          </Button>
          <Button
            type="button"
            disabled={busy || items.length === 0 || Boolean(capWarning)}
            onClick={() => void submit()}
          >
            {busy ? "Sende…" : "An AMS senden"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
