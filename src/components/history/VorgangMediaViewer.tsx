import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VideoPlayer } from "@/components/VideoPlayer";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "@/components/MediaFileContextMenu";
import type { ViewableMediaItem } from "@/lib/vorgangHistory";
import {
  isPreviewOrWmRole,
  partitionDeliveryAndPreview,
} from "@/lib/vorgangMediaPlaylist";
import { useVideoThumbnailSrc } from "@/hooks/useVideoThumbnailSrc";
import { THUMB_PRIORITY } from "@/lib/thumbnailQueue";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";

type MediaTab = "video" | "foto";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  guestName: string;
  /** Local Vorgang output folder (Explorer / Finder). */
  folderPath?: string | null;
  items: ViewableMediaItem[];
  index: number;
  onIndexChange: (index: number) => void;
  roleLabel: (role: string) => string;
};

function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function itemKey(item: ViewableMediaItem): string {
  return `${item.id ?? "x"}:${item.path}`;
}

function ThumbTile({
  item,
  selected,
  onSelect,
  onContextMenu,
  photoSrc,
}: {
  item: ViewableMediaItem;
  selected: boolean;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  photoSrc: string | null;
}) {
  const { t } = useTranslation();
  const isVideo = item.media_type === "video";
  const isPreview = isPreviewOrWmRole(item.role);
  const videoThumb = useVideoThumbnailSrc(
    isVideo ? item.path : null,
    item.size_bytes ?? 0,
    THUMB_PRIORITY.warm,
    { enabled: isVideo },
  );
  const thumbSrc = isVideo ? videoThumb : photoSrc;

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={item.filename}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full flex-col overflow-hidden rounded-lg text-left ring-1 transition",
        selected
          ? "ring-2 ring-primary shadow-md"
          : "ring-border/70 hover:ring-primary/45",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-[var(--ats-preview-stage)]">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : isVideo ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-white/85">
            <Film className="h-6 w-6 opacity-85" aria-hidden />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-white/60">
            <ImageIcon className="h-6 w-6" aria-hidden />
          </div>
        )}
        {isVideo && thumbSrc ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15">
            <Film className="h-5 w-5 text-white/90 drop-shadow" aria-hidden />
          </span>
        ) : null}
        {isPreview ? (
          <span className="absolute top-1 left-1 rounded bg-amber-500/90 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-amber-950 uppercase shadow-sm">
            {item.role === "wm_video"
              ? t("history.viewer.badgeWm")
              : t("history.viewer.badgePreview")}
          </span>
        ) : null}
        {selected ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
        ) : null}
      </div>
      <span
        className={cn(
          "truncate border-t border-border/50 bg-card-elevated/90 px-1.5 py-1 text-[10px] leading-tight",
          selected ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {item.filename}
      </span>
    </button>
  );
}

function TileSection({
  title,
  items,
  current,
  photoThumbSrc,
  onSelect,
  onContextMenuPath,
}: {
  title: string;
  items: ViewableMediaItem[];
  current: ViewableMediaItem | null;
  photoThumbSrc: Map<string, string>;
  onSelect: (item: ViewableMediaItem) => void;
  onContextMenuPath: (path: string) => (e: React.MouseEvent) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted">
          {items.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div
            key={itemKey(item)}
            role="option"
            aria-selected={current != null && itemKey(item) === itemKey(current)}
          >
            <ThumbTile
              item={item}
              selected={current != null && itemKey(item) === itemKey(current)}
              onSelect={() => onSelect(item)}
              onContextMenu={onContextMenuPath(item.path)}
              photoSrc={
                item.media_type === "photo"
                  ? (photoThumbSrc.get(itemKey(item)) ?? null)
                  : null
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailPanel({
  current,
  tabCount,
  tabIndex,
  totalBytes,
  roleLabel,
  onRevealFile,
  onOpenFile,
}: {
  current: ViewableMediaItem | null;
  tabCount: number;
  tabIndex: number;
  totalBytes: number;
  roleLabel: (role: string) => string;
  onRevealFile: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const positionCurrent = tabCount === 0 ? 0 : tabIndex + 1;
  return (
    <div className="shrink-0 rounded-xl border border-border/60 bg-card-elevated/80 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[10px] font-semibold tracking-wide text-muted uppercase">
          {t("history.viewer.detailTitle")}{" "}
          <span className="font-medium normal-case tracking-normal tabular-nums text-muted-foreground">
            {positionCurrent} / {tabCount}
            {" · "}
            {t("history.viewer.totalSize")}: {formatBytes(totalBytes)}
          </span>
        </p>
        {current ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[11px]"
              title={t("media.contextMenu.revealInFolder")}
              onClick={() => onRevealFile(current.path)}
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">
                {t("media.contextMenu.revealInFolder")}
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 gap-1 px-2 text-[11px]"
              title={t("media.contextMenu.open")}
              onClick={() => onOpenFile(current.path)}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t("media.contextMenu.open")}</span>
            </Button>
          </div>
        ) : null}
      </div>
      {current ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-[10px] text-muted-foreground">
              {t("history.col.name")}
            </dt>
            <dd className="mt-0.5 truncate font-medium text-foreground" title={current.filename}>
              {current.filename}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">
              {t("history.col.role")}
            </dt>
            <dd className="mt-0.5 text-foreground">{roleLabel(current.role)}</dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">
              {t("history.col.type")}
            </dt>
            <dd className="mt-0.5 text-foreground">
              {current.media_type === "video"
                ? t("common.labels.video")
                : t("common.labels.photo")}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">
              {t("history.col.size")}
            </dt>
            <dd className="mt-0.5 tabular-nums text-foreground">
              {formatBytes(current.size_bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">
              {t("history.col.source")}
            </dt>
            <dd className="mt-0.5">
              {current.append_id != null ? (
                <span
                  className="inline-flex rounded-md bg-violet-500/12 px-2 py-0.5 text-[11px] font-medium text-violet-900 ring-1 ring-inset ring-violet-500/30 dark:text-violet-100"
                  title={
                    current.append_folder_name
                      ? t("history.appendedFolder", {
                          folder: current.append_folder_name,
                        })
                      : t("history.appended")
                  }
                >
                  {t("history.appended")}
                </span>
              ) : (
                <span className="text-muted-foreground">{t("history.original")}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-[10px] text-muted-foreground">
              {t("history.viewer.path")}
            </dt>
            <dd
              className="mt-0.5 truncate text-[11px] text-muted-foreground"
              title={current.path}
            >
              {current.path}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">{t("history.viewer.emptyTab")}</p>
      )}
    </div>
  );
}

export function VorgangMediaViewer({
  open,
  onOpenChange,
  guestName,
  folderPath,
  items,
  index,
  onIndexChange,
  roleLabel,
}: Props) {
  const { t } = useTranslation();
  const showError = useUiStore((s) => s.showError);
  const [tab, setTab] = useState<MediaTab>("video");
  const [photoFailed, setPhotoFailed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);

  const videos = useMemo(
    () => items.filter((item) => item.media_type === "video"),
    [items],
  );
  const photos = useMemo(
    () => items.filter((item) => item.media_type === "photo"),
    [items],
  );

  const current = index >= 0 && index < items.length ? items[index] : null;
  const tabItems = tab === "video" ? videos : photos;
  const tabIndex = current
    ? tabItems.findIndex((item) => itemKey(item) === itemKey(current))
    : -1;
  const { delivery: tabDelivery, preview: tabPreview } = useMemo(
    () => partitionDeliveryAndPreview(tabItems),
    [tabItems],
  );

  const videoBytes = useMemo(
    () => videos.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0),
    [videos],
  );
  const photoBytes = useMemo(
    () => photos.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0),
    [photos],
  );

  // Sync tab when opening or when external index points at another media type.
  useEffect(() => {
    if (!open) return;
    const item = index >= 0 && index < items.length ? items[index] : null;
    if (item?.media_type === "photo") setTab("foto");
    else if (item?.media_type === "video") setTab("video");
    else if (videos.length > 0) setTab("video");
    else if (photos.length > 0) setTab("foto");
  }, [open, index, items, videos.length, photos.length]);

  useEffect(() => {
    setPhotoFailed(false);
  }, [current?.path]);

  useEffect(() => {
    if (!open || tabItems.length === 0) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      if (tabIndex < 0) return;
      const next =
        ev.key === "ArrowLeft"
          ? Math.max(0, tabIndex - 1)
          : Math.min(tabItems.length - 1, tabIndex + 1);
      const target = tabItems[next];
      if (!target) return;
      const global = items.findIndex((item) => itemKey(item) === itemKey(target));
      if (global >= 0) onIndexChange(global);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, tabItems, tabIndex, items, onIndexChange]);

  const photoSrc = useMemo(() => {
    if (!current || current.media_type !== "photo") return null;
    try {
      return convertFileSrc(current.path);
    } catch {
      return null;
    }
  }, [current]);

  const photoThumbSrc = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of photos) {
      try {
        map.set(itemKey(item), convertFileSrc(item.path));
      } catch {
        /* ignore */
      }
    }
    return map;
  }, [photos]);

  function selectItem(item: ViewableMediaItem) {
    const global = items.findIndex((row) => itemKey(row) === itemKey(item));
    if (global >= 0) onIndexChange(global);
  }

  function switchTab(next: MediaTab) {
    setTab(next);
    const list = next === "video" ? videos : photos;
    if (list.length === 0) return;
    // Keep current if already on this tab; otherwise first item.
    if (current && list.some((item) => itemKey(item) === itemKey(current))) return;
    selectItem(list[0]!);
  }

  function goRelative(delta: number) {
    if (tabIndex < 0 || tabItems.length === 0) return;
    const next = Math.min(tabItems.length - 1, Math.max(0, tabIndex + delta));
    const target = tabItems[next];
    if (target) selectItem(target);
  }

  const canOpenFolder = Boolean(folderPath?.trim());
  const onTileContextMenu = (path: string) => mediaContextMenuHandler(path, setCtxMenu);

  async function openVorgangFolder() {
    const path = folderPath?.trim();
    if (!path) return;
    try {
      await openPath(path);
    } catch (e) {
      showError(String(e), t("history.viewer.openFolder"));
    }
  }

  async function revealFile(path: string) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      showError(String(e), t("media.contextMenu.revealInFolder"));
    }
  }

  async function openFileExternally(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      showError(String(e), t("media.contextMenu.open"));
    }
  }

  const canPrev = tabIndex > 0;
  const canNext = tabIndex >= 0 && tabIndex < tabItems.length - 1;
  const stageEmpty = tabItems.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCtxMenu(null);
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="z-[100] flex h-[min(88vh,44rem)] w-[min(72rem,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0"
        overlayClassName="z-[100]"
      >
        <div className="shrink-0 border-b border-border/70 px-4 pt-4 pr-12 pb-3 sm:px-5 sm:pr-14">
          <div className="flex flex-wrap items-start gap-3">
            <DialogHeader className="min-w-0 flex-1 space-y-1 text-left">
              <DialogTitle>
                {t("history.viewer.title", { name: guestName || "—" })}
              </DialogTitle>
              <DialogDescription>
                {t("history.viewer.subtitle", { count: items.length })}
              </DialogDescription>
            </DialogHeader>
            {canOpenFolder ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5"
                title={folderPath ?? undefined}
                onClick={() => void openVorgangFolder()}
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                {t("history.viewer.openFolder")}
              </Button>
            ) : null}
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => switchTab(v === "foto" ? "foto" : "video")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/70 bg-card-elevated/50 px-3 py-2.5 sm:px-5">
            <TabsList
              className="h-11 w-full max-w-md flex-1 p-1 sm:w-auto"
              aria-label={t("app.media.kindAria")}
            >
              <TabsTrigger
                value="video"
                className="h-full flex-1 gap-2 px-4 data-[state=active]:text-primary"
                disabled={videos.length === 0 && photos.length > 0}
              >
                <Film className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t("common.labels.video")}</span>
                {videos.length > 0 ? (
                  <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs tabular-nums text-muted">
                    {videos.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="foto"
                className="h-full flex-1 gap-2 px-4 data-[state=active]:text-primary"
                disabled={photos.length === 0 && videos.length > 0}
              >
                <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t("common.labels.photo")}</span>
                {photos.length > 0 ? (
                  <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs tabular-nums text-muted">
                    {photos.length}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
            {tabItems.length > 1 ? (
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  className="rounded-lg border border-border/60 bg-background/60 p-1.5 text-foreground transition hover:bg-background disabled:opacity-40"
                  disabled={!canPrev}
                  aria-label={t("history.viewer.prev")}
                  onClick={() => goRelative(-1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground">
                  {t("history.viewer.counter", {
                    current: tabIndex + 1,
                    total: tabItems.length,
                  })}
                </span>
                <button
                  type="button"
                  className="rounded-lg border border-border/60 bg-background/60 p-1.5 text-foreground transition hover:bg-background disabled:opacity-40"
                  disabled={!canNext}
                  aria-label={t("history.viewer.next")}
                  onClick={() => goRelative(1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>

          {(["video", "foto"] as const).map((tabId) => (
            <TabsContent
              key={tabId}
              value={tabId}
              className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 sm:p-4 md:grid-cols-2 md:items-stretch">
                <div
                  className={cn(
                    "min-h-[10rem] overflow-y-auto overflow-x-hidden rounded-xl border border-border/60 bg-card-elevated/40 p-2 [scrollbar-gutter:stable] md:min-h-0",
                    !(tabItems.length > 0 && tab === tabId) && "flex items-center justify-center",
                  )}
                  role="listbox"
                  aria-label={t("history.viewer.tileListAria")}
                >
                  {tabItems.length > 0 && tab === tabId ? (
                    <div className="space-y-4">
                      <TileSection
                        title={t("history.viewer.sectionDelivery")}
                        items={tabDelivery}
                        current={current}
                        photoThumbSrc={photoThumbSrc}
                        onSelect={selectItem}
                        onContextMenuPath={onTileContextMenu}
                      />
                      {tabPreview.length > 0 && tabDelivery.length > 0 ? (
                        <div className="border-t border-border/50" />
                      ) : null}
                      <TileSection
                        title={t("history.viewer.sectionPreview")}
                        items={tabPreview}
                        current={current}
                        photoThumbSrc={photoThumbSrc}
                        onSelect={selectItem}
                        onContextMenuPath={onTileContextMenu}
                      />
                    </div>
                  ) : (
                    <p className="px-3 text-center text-xs text-muted-foreground">
                      {t("history.viewer.emptyTab")}
                    </p>
                  )}
                </div>

                <div className="flex min-h-0 min-w-0 flex-col gap-3">
                  <div className="relative flex min-h-[14rem] flex-1 items-center justify-center overflow-hidden rounded-xl bg-[var(--ats-preview-stage)] ring-1 ring-border md:min-h-0">
                    {stageEmpty || tab !== tabId ? (
                      <div className="flex flex-col items-center justify-center gap-2 px-4 text-center text-sm text-white/75">
                        {tabId === "video" ? (
                          <Film className="h-8 w-8 opacity-50" aria-hidden />
                        ) : (
                          <ImageIcon className="h-8 w-8 opacity-50" aria-hidden />
                        )}
                        <p>{t("history.viewer.emptyTab")}</p>
                      </div>
                    ) : current?.media_type === "video" && tabId === "video" ? (
                      <VideoPlayer
                        key={current.path}
                        srcPath={open ? current.path : null}
                        className="h-full w-full"
                        chrome="playback"
                        autoPlay={open}
                        fillAvailable
                      />
                    ) : current?.media_type === "photo" &&
                      tabId === "foto" &&
                      photoSrc &&
                      !photoFailed ? (
                      <>
                        <img
                          src={photoSrc}
                          alt={current.filename}
                          className="max-h-full max-w-full object-contain"
                          draggable={false}
                          onError={() => setPhotoFailed(true)}
                        />
                        {tabItems.length > 1 ? (
                          <>
                            <button
                              type="button"
                              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65 disabled:opacity-40"
                              onClick={() => goRelative(-1)}
                              disabled={!canPrev}
                              aria-label={t("history.viewer.prev")}
                            >
                              <ChevronLeft className="h-5 w-5" />
                            </button>
                            <button
                              type="button"
                              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65 disabled:opacity-40"
                              onClick={() => goRelative(1)}
                              disabled={!canNext}
                              aria-label={t("history.viewer.next")}
                            >
                              <ChevronRight className="h-5 w-5" />
                            </button>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-sm text-white/70">
                        {t("history.viewer.loadError")}
                      </p>
                    )}
                  </div>

                  <DetailPanel
                    current={
                      tab === tabId &&
                      current?.media_type === (tabId === "video" ? "video" : "photo")
                        ? current
                        : null
                    }
                    tabCount={tabId === "video" ? videos.length : photos.length}
                    tabIndex={
                      tab === tabId &&
                      current?.media_type === (tabId === "video" ? "video" : "photo")
                        ? Math.max(0, tabIndex)
                        : 0
                    }
                    totalBytes={tabId === "video" ? videoBytes : photoBytes}
                    roleLabel={roleLabel}
                    onRevealFile={(path) => void revealFile(path)}
                    onOpenFile={(path) => void openFileExternally(path)}
                  />
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(message) => showError(message)}
        className="z-[110]"
      />
    </Dialog>
  );
}
