import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Check,
  ChevronLeft,
  Film,
  FolderOpen,
  ImageIcon,
  Info,
  Upload,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type AppendCategoryId,
  type AppendMediaItem,
  type VorgangEntry,
} from "../lib/vorgangHistory";
import { amsBridgeHealth } from "../lib/tauri";
import { getMediaThumbnail, thumbnailDisplayUrl } from "../lib/sdCard";
import {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  mediaKind,
} from "../lib/media";
import { expandMediaPaths } from "../lib/tauri";
import { useAppendStore } from "@/store/appendStore";

type Props = {
  vorgang: VorgangEntry;
  onBack: () => void;
  onSubmit: (items: AppendMediaItem[]) => void;
  /** While the native file picker is open (parent dialog must stay open). */
  onPickingFilesChange?: (picking: boolean) => void;
};

export type AppendMediaPanelHandle = {
  requestBack: () => void;
};

type DraftItem = AppendMediaItem & {
  name: string;
  thumb?: string;
};

type CatGroupId = "handcam" | "outside";
type CatStatus = "paid" | "open" | "new";

type CatDef = {
  id: AppendCategoryId;
  labelKey: string;
  kindLabelKey: string;
  group: CatGroupId;
  video: boolean;
  booked: (v: VorgangEntry) => boolean;
  paid: (v: VorgangEntry) => boolean;
};

const CATS: CatDef[] = [
  {
    id: "handcam_foto",
    labelKey: "history.appendPanel.catHandcamFoto",
    kindLabelKey: "common.labels.photo",
    group: "handcam",
    video: false,
    booked: (v) => v.handcam_foto,
    paid: (v) => v.ist_bezahlt_handcam_foto,
  },
  {
    id: "handcam_video",
    labelKey: "history.appendPanel.catHandcamVideo",
    kindLabelKey: "common.labels.video",
    group: "handcam",
    video: true,
    booked: (v) => v.handcam_video,
    paid: (v) => v.ist_bezahlt_handcam_video,
  },
  {
    id: "outside_foto",
    labelKey: "history.appendPanel.catOutsideFoto",
    kindLabelKey: "common.labels.photo",
    group: "outside",
    video: false,
    booked: (v) => v.outside_foto,
    paid: (v) => v.ist_bezahlt_outside_foto,
  },
  {
    id: "outside_video",
    labelKey: "history.appendPanel.catOutsideVideo",
    kindLabelKey: "common.labels.video",
    group: "outside",
    video: true,
    booked: (v) => v.outside_video,
    paid: (v) => v.ist_bezahlt_outside_video,
  },
];

const CAT_GROUPS: { id: CatGroupId; labelKey: string }[] = [
  { id: "handcam", labelKey: "history.appendPanel.groupHandcam" },
  { id: "outside", labelKey: "history.appendPanel.groupOutside" },
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
  t: (key: string) => string,
): string {
  const c = catDef(item.category);
  if (!c) {
    return item.preview
      ? t("history.appendPanel.modeOriginalPreview")
      : t("history.appendPanel.modeOriginal");
  }
  if (c.booked(v) && c.paid(v)) return t("history.appendPanel.modeOriginal");
  if (item.preview) return t("history.appendPanel.modeOriginalPreview");
  return t("history.appendPanel.modeOriginal");
}

function categoryStatus(v: VorgangEntry | null, c: CatDef): CatStatus {
  if (!v || !c.booked(v)) return "new";
  if (!c.paid(v)) return "open";
  return "paid";
}

function CatStatusChip({
  status,
  t,
}: {
  status: CatStatus;
  t: (key: string) => string;
}) {
  if (status === "paid") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-900 dark:text-emerald-100">
        <Check className="size-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
        {t("history.appendPanel.statusPaid")}
      </span>
    );
  }
  if (status === "open") {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-950 dark:text-amber-100">
        {t("history.appendPanel.statusOpen")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      {t("history.appendPanel.statusNew")}
    </span>
  );
}

function statusHintFor(
  status: CatStatus,
  t: (key: string) => string,
): { text: string; className: string } {
  const hints: Record<CatStatus, { textKey: string; className: string }> = {
    paid: {
      textKey: "history.appendPanel.hintPaid",
      className:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
    },
    open: {
      textKey: "history.appendPanel.hintOpen",
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100",
    },
    new: {
      textKey: "history.appendPanel.hintNew",
      className: "border-border/60 bg-muted/20 text-muted-foreground",
    },
  };
  const h = hints[status];
  return { text: t(h.textKey), className: h.className };
}

export const AppendMediaPanel = forwardRef<AppendMediaPanelHandle, Props>(
  function AppendMediaPanel(
    { vorgang, onBack, onSubmit, onPickingFilesChange },
    ref,
  ) {
    const { t } = useTranslation();
    const [category, setCategory] = useState<AppendCategoryId>("handcam_foto");
    const [items, setItems] = useState<DraftItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [capWarning, setCapWarning] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [discardOpen, setDiscardOpen] = useState(false);
    const submittingRef = useRef(false);
    const setCaptureFileDrop = useAppendStore((s) => s.setCaptureFileDrop);

    const activeCat = useMemo(() => catDef(category), [category]);
    const selectedStatus = activeCat
      ? categoryStatus(vorgang, activeCat)
      : "new";
    const statusHint = statusHintFor(selectedStatus, t);

    const groupedItems = useMemo(
      () =>
        CATS.map((c) => ({
          cat: c,
          items: items.filter((i) => i.category === c.id),
        })).filter((g) => g.items.length > 0),
      [items],
    );

    const canSend =
      !busy && items.length > 0 && !capWarning && !submittingRef.current;

    const requestBack = useCallback(() => {
      if (busy || submittingRef.current) return;
      if (discardOpen) {
        setDiscardOpen(false);
        return;
      }
      if (items.length > 0) {
        setDiscardOpen(true);
        return;
      }
      onBack();
    }, [busy, discardOpen, items.length, onBack]);

    useImperativeHandle(ref, () => ({ requestBack }), [requestBack]);

    useEffect(() => {
      const firstBooked =
        CATS.find((c) => c.id === "handcam_video" && c.booked(vorgang)) ??
        CATS.find((c) => c.booked(vorgang));
      const next = firstBooked?.id ?? "handcam_video";
      setCategory(next);
      setItems([]);
      setError(null);
      setBusy(false);
      setCapWarning(null);
      setDragOver(false);
      setDiscardOpen(false);
      submittingRef.current = false;
      void amsBridgeHealth()
        .then((h) => {
          if (h.ok && h.health && !h.health.capabilities.includes("append-v1")) {
            setCapWarning(t("history.appendPanel.capWarning"));
          }
        })
        .catch(() => {
          /* Datei-Handoff bleibt Fallback */
        });
    }, [vorgang.id]);

    const ingestPaths = useCallback(
      async (rawPaths: string[]) => {
        if (busy || submittingRef.current) return;
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
                ? t("history.appendPanel.noVideos")
                : t("history.appendPanel.noPhotos"),
            );
          } else if (skippedKind > 0) {
            setError(
              cat.video
                ? t("history.appendPanel.wrongKindVideo")
                : t("history.appendPanel.wrongKindPhoto"),
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
                  p.path === item.path
                    ? { ...p, thumb: thumbnailDisplayUrl(t) }
                    : p,
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
    }, [busy, ingestPaths, setCaptureFileDrop]);

    async function addFiles() {
      const cat = catDef(category);
      if (!cat) return;
      let selected: string | string[] | null;
      onPickingFilesChange?.(true);
      try {
        selected = await openDialog({
          title: cat.video
            ? t("history.appendPanel.pickVideos")
            : t("history.appendPanel.pickPhotos"),
          multiple: true,
          filters: [
            {
              name: cat.video
                ? t("common.labels.videos")
                : t("common.labels.photos"),
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
      let selected: string | string[] | null;
      onPickingFilesChange?.(true);
      try {
        selected = await openDialog({
          title: t("history.appendPanel.pickFolder"),
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

    function setGroupPreview(id: AppendCategoryId, preview: boolean) {
      setItems((prev) =>
        prev.map((i) => (i.category === id ? { ...i, preview } : i)),
      );
    }

    function submit() {
      if (items.length === 0 || busy) return;

      const notPaidPhotos = items.filter(
        (i) => categoryNotPaid(vorgang, i.category) && !catDef(i.category)?.video,
      );
      if (notPaidPhotos.length > 0 && !notPaidPhotos.some((i) => i.preview)) {
        setError(t("history.appendPanel.previewPhotoRequired"));
        return;
      }

      const notPaidVideos = items.filter(
        (i) => categoryNotPaid(vorgang, i.category) && catDef(i.category)?.video,
      );
      if (notPaidVideos.length > 0 && !notPaidVideos.some((i) => i.preview)) {
        setError(t("history.appendPanel.previewVideoRequired"));
        return;
      }

      setBusy(true);
      setError(null);
      submittingRef.current = true;

      const payload: AppendMediaItem[] = items.map(
        ({ path, category, preview }) => ({
          path,
          category,
          preview,
        }),
      );

      onSubmit(payload);
      setBusy(false);
      submittingRef.current = false;
    }

    return (
      <div className="relative flex h-full min-h-0 flex-col bg-card">
        <header className="grid shrink-0 grid-cols-[minmax(5.5rem,1fr)_auto_minmax(5.5rem,1fr)] items-center border-b border-border/60 px-2 py-1.5 sm:px-3">
          <button
            type="button"
            disabled={busy}
            onClick={requestBack}
            className="inline-flex items-center justify-self-start rounded-md py-1 pr-2 text-[15px] font-normal text-primary transition hover:brightness-110 disabled:opacity-40"
          >
            <ChevronLeft className="size-5 shrink-0" strokeWidth={2.25} />
            {t("history.title")}
          </button>
          <div className="min-w-0 text-center">
            <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              {t("history.appendDialogTitle")}
            </h2>
            <p className="truncate text-[11px] leading-tight text-muted">
              {vorgang.gast}
            </p>
          </div>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => submit()}
            className={cn(
              "justify-self-end rounded-md px-1.5 py-1 text-[15px] font-semibold transition",
              canSend
                ? "text-primary hover:brightness-110"
                : "cursor-not-allowed text-muted/40",
            )}
          >
            {t("history.appendPanel.send")}
          </button>
        </header>

        {capWarning ? (
          <p className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-950 dark:text-amber-100">
            {capWarning}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(17.5rem,0.92fr)_minmax(0,1.08fr)]">
          <section className="flex min-h-0 flex-col gap-3 overflow-y-auto border-b border-border/60 p-3 lg:border-b-0 lg:border-r">
            <div>
              <h3 className="px-1 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                {t("history.appendPanel.productTitle")}
              </h3>
              <div
                className="space-y-3"
                role="radiogroup"
                aria-label={t("history.appendPanel.productAria")}
              >
                {CAT_GROUPS.map((group) => (
                  <div key={group.id}>
                    <p className="px-1 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                      {t(group.labelKey)}
                    </p>
                    <div className="overflow-hidden rounded-xl bg-card-elevated ring-1 ring-border/60">
                      {CATS.filter((c) => c.group === group.id).map((c, idx, arr) => {
                        const active = category === c.id;
                        const status = categoryStatus(vorgang, c);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={busy}
                            onClick={() => setCategory(c.id)}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              "disabled:cursor-not-allowed",
                              idx < arr.length - 1 && "border-b border-border/50",
                              active
                                ? "bg-primary-soft"
                                : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-[9px]",
                                active
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-black/8 text-muted-foreground dark:bg-white/10",
                              )}
                              aria-hidden
                            >
                              {c.video ? (
                                <Film className="size-4" />
                              ) : (
                                <ImageIcon className="size-4" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[15px] font-medium leading-tight">
                                {t(c.labelKey)}
                              </span>
                              <span className="mt-1 block">
                                <CatStatusChip status={status} t={t} />
                              </span>
                            </span>
                            {active ? (
                              <Check
                                className="size-4 shrink-0 text-primary"
                                strokeWidth={2.5}
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <p
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-xl px-3 py-2 text-xs leading-5 ring-1",
                statusHint.className,
              )}
            >
              {selectedStatus === "paid" ? (
                <Check
                  className="mt-0.5 size-3.5 shrink-0"
                  strokeWidth={2.5}
                  aria-hidden
                />
              ) : (
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
              <span className="leading-5">{statusHint.text}</span>
            </p>

            <div
              className={cn(
                "relative flex min-h-[9.5rem] flex-1 flex-col justify-center overflow-hidden rounded-xl px-3 py-4 text-center transition-[border-color,background-color,box-shadow,transform] duration-200",
                "ring-2 ring-dashed",
                dragOver
                  ? "scale-[1.01] bg-primary-soft ring-primary shadow-[inset_0_0_0_1px] shadow-primary/30"
                  : "bg-card-elevated/70 ring-border hover:ring-primary/40",
                busy && "pointer-events-none opacity-60",
              )}
              role="region"
              aria-label={
                activeCat?.video
                  ? t("history.appendPanel.dropVideos")
                  : t("history.appendPanel.dropPhotos")
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
                <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary ring-1 ring-primary/15">
                  {dragOver ? (
                    <Upload className="h-4 w-4 animate-pulse" aria-hidden />
                  ) : activeCat?.video ? (
                    <Film className="h-4 w-4" aria-hidden />
                  ) : (
                    <ImageIcon className="h-4 w-4" aria-hidden />
                  )}
                </div>
                <p className="mb-0.5 text-[13px] font-medium leading-5 text-foreground">
                  {dragOver
                    ? t("history.appendPanel.dropRelease")
                    : activeCat?.video
                      ? t("history.appendPanel.dropVideos")
                      : t("history.appendPanel.dropPhotos")}
                </p>
                <p className="mb-3 text-[11px] leading-4 text-muted">
                  {activeCat?.video
                    ? t("history.appendPanel.dropHintVideo")
                    : t("history.appendPanel.dropHintPhoto")}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => void addFiles()}
                  >
                    {t("history.appendPanel.pickFilesBtn")}
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
                    {t("history.appendPanel.pickFolderBtn")}
                  </Button>
                </div>
              </div>
            </div>

            {error ? (
              <p className="px-1 text-xs text-destructive">{error}</p>
            ) : null}
          </section>

          <section className="flex min-h-0 flex-col bg-card-elevated/40">
            <div className="flex shrink-0 items-baseline justify-between gap-2 px-4 py-2.5">
              <h3 className="text-[13px] font-semibold tracking-tight text-foreground">
                {t("history.files")}
              </h3>
              <span className="text-[13px] tabular-nums text-muted">
                {items.length === 0
                  ? t("history.appendPanel.noneCount")
                  : items.length === 1
                    ? t("history.appendPanel.fileCountOne", { count: items.length })
                    : t("history.appendPanel.fileCountMany", { count: items.length })}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              {items.length === 0 ? (
                <div className="flex h-full min-h-[12rem] flex-col items-center justify-center px-6 text-center">
                  <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-black/6 text-muted dark:bg-white/8">
                    {activeCat?.video ? (
                      <Film className="size-5" aria-hidden />
                    ) : (
                      <ImageIcon className="size-5" aria-hidden />
                    )}
                  </div>
                  <p className="text-[15px] font-medium text-foreground">
                    {t("history.appendPanel.emptyFiles")}
                  </p>
                  <p className="mt-1 max-w-[16rem] text-[13px] leading-5 text-muted">
                    {t("history.appendPanel.emptyFilesHint")}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {groupedItems.map(({ cat, items: groupItems }) => {
                    const showPreview = categoryNotPaid(vorgang, cat.id);
                    const allPreview =
                      showPreview && groupItems.every((i) => i.preview);
                    return (
                      <div key={cat.id}>
                        <div className="flex items-center justify-between gap-2 px-1 pb-1">
                          <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                            {t(cat.labelKey)}
                            <span className="ml-1.5 tabular-nums font-medium tracking-normal text-muted/80">
                              {groupItems.length}
                            </span>
                          </p>
                          {showPreview ? (
                            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted">
                              {t("history.appendPanel.previewLabel")}
                              <Switch
                                checked={allPreview}
                                disabled={busy}
                                onCheckedChange={(v) =>
                                  setGroupPreview(cat.id, v)
                                }
                              />
                            </label>
                          ) : null}
                        </div>
                        <ul className="overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
                          {groupItems.map((item, idx) => (
                            <li
                              key={item.path}
                              className={cn(
                                "flex items-center gap-3 px-3 py-2",
                                idx < groupItems.length - 1 &&
                                  "border-b border-border/50",
                              )}
                            >
                              {item.thumb ? (
                                <img
                                  src={item.thumb}
                                  alt=""
                                  className="size-11 shrink-0 rounded-[9px] object-cover"
                                />
                              ) : (
                                <div className="flex size-11 shrink-0 items-center justify-center rounded-[9px] bg-muted/40 text-muted">
                                  {cat.video ? (
                                    <Film className="size-4" aria-hidden />
                                  ) : (
                                    <ImageIcon className="size-4" aria-hidden />
                                  )}
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div
                                  className="truncate text-[13px] font-medium"
                                  title={item.path}
                                >
                                  {item.name}
                                </div>
                                <div className="truncate text-[11px] text-muted">
                                  {itemModeLabel(vorgang, item, t)}
                                </div>
                              </div>
                              {showPreview ? (
                                <Switch
                                  checked={item.preview}
                                  disabled={busy}
                                  aria-label={t("history.appendPanel.previewAria", {
                                    name: item.name,
                                  })}
                                  onCheckedChange={(v) =>
                                    toggleItemPreview(item.path, v)
                                  }
                                />
                              ) : null}
                              <button
                                type="button"
                                disabled={busy}
                                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-black/6 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/8"
                                aria-label={t("history.appendPanel.removeItemAria", {
                                  name: item.name,
                                })}
                                onClick={() => removeItem(item.path)}
                              >
                                <X className="size-3.5" strokeWidth={2.25} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {discardOpen ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px] dark:bg-black/45">
            <div
              role="alertdialog"
              aria-labelledby="append-discard-title"
              aria-describedby="append-discard-desc"
              className="w-[19.5rem] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl"
            >
              <div className="px-5 pb-3 pt-5 text-center">
                <p
                  id="append-discard-title"
                  className="text-[17px] font-semibold tracking-tight"
                >
                  {t("history.appendPanel.discardTitle")}
                </p>
                <p
                  id="append-discard-desc"
                  className="mt-1.5 text-[13px] leading-5 text-muted"
                >
                  {items.length === 1
                    ? t("history.appendPanel.discardOne")
                    : t("history.appendPanel.discardMany", { count: items.length })}
                </p>
              </div>
              <div className="flex flex-col border-t border-border/60">
                <button
                  type="button"
                  className="px-4 py-3 text-[17px] font-semibold text-destructive transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  onClick={onBack}
                >
                  {t("history.appendPanel.discard")}
                </button>
                <button
                  type="button"
                  className="border-t border-border/60 px-4 py-3 text-[17px] font-normal text-primary transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  onClick={() => setDiscardOpen(false)}
                >
                  {t("history.appendPanel.continueEditing")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
    },
  );

AppendMediaPanel.displayName = "AppendMediaPanel";
