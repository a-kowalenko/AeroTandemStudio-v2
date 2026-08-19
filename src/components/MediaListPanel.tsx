import { useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, QrCode, X } from "lucide-react";
import { useVideoStore } from "../store/videoStore";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useUiStore } from "../store/uiStore";
import { withQrScanProgress } from "../store/qrScanStore";
import type { VideoMetadata } from "../lib/tauri";
import { scanQrPhoto, scanQrVideo } from "../lib/tauri";
import { formatCameraLabel } from "../lib/cameraLabel";
import {
  maybeRemoveQrPhoto,
  maybeRemoveQrVideo,
} from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import { requestKundenIdFocus } from "../lib/kundenIdFocus";
import { QrScanRowBar } from "../hooks/useQrScanProgress";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn } from "@/lib/utils";

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "?:??";
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function photoFormatLabel(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  const mp = (width * height) / 1_000_000;
  const mpLabel =
    mp >= 10 ? `${Math.round(mp)} MP` : `${mp.toFixed(1)} MP`;
  return `${width}×${height} · ${mpLabel}`;
}

function formatLabel(v: VideoMetadata): string {
  const res = v.height > 0 ? `${v.height}p` : "—";
  const fps = v.fps > 0 ? `@${Math.round(v.fps)}` : "";
  return `${res}${fps}`;
}

type SortableRowProps = {
  video: VideoMetadata;
  index: number;
  onRemove: (path: string) => void;
  onScanQr: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string) => void;
  qrBusy: boolean;
  showWatermark?: boolean;
  watermarkSelected?: boolean;
  onToggleWatermark?: (index: number) => void;
  cutMark?: "trim" | "split" | "rotate" | null;
};

function SortableVideoRow({
  video,
  index,
  onRemove,
  onScanQr,
  onContextMenu,
  qrBusy,
  showWatermark,
  watermarkSelected,
  onToggleWatermark,
  cutMark,
}: SortableRowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: video.path });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
  };
  const device = formatCameraLabel(video.camera_make, video.camera_model);

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={cn(
        "group border-b border-border/70 text-sm last:border-0",
        isDragging && "bg-primary-soft",
      )}
      onContextMenu={(e) => onContextMenu(e, video.path)}
    >
      <td
        className="w-8 cursor-grab px-2 py-2 text-muted active:cursor-grabbing"
        {...attributes}
        {...listeners}
        title={t("media.list.dragSort")}
      >
        <GripVertical className="h-4 w-4" />
      </td>
      <td className="w-8 px-1 py-2 tabular-nums text-muted">{index + 1}</td>
      <td className="max-w-[12rem] px-2 py-2 font-medium" title={video.path}>
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 truncate">{video.filename}</div>
          {cutMark ? (
            <span
              className="shrink-0 rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white"
              title={
                cutMark === "trim"
                  ? t("media.list.trimmed")
                  : cutMark === "rotate"
                    ? t("media.list.rotated")
                    : t("media.list.split")
              }
            >
              {cutMark === "trim" ? "Trim" : cutMark === "rotate" ? "Rot" : "Split"}
            </span>
          ) : null}
        </div>
        {device ? (
          <div className="truncate text-xs text-muted" title={device}>
            {device}
          </div>
        ) : null}
        <QrScanRowBar path={video.path} />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-muted">{formatLabel(video)}</td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
        {formatDuration(video.duration_secs)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
        {formatSize(video.size_bytes)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 font-mono text-xs text-muted">
        {video.codec}
      </td>
      {showWatermark ? (
        <td className="w-10 px-1 py-2 text-center">
          <Checkbox
            checked={Boolean(watermarkSelected)}
            onCheckedChange={() => onToggleWatermark?.(index)}
            aria-label={t("media.list.wmClipAria")}
            title={t("media.list.wmClipTitle")}
          />
        </td>
      ) : null}
      <td className="w-[4.5rem] px-1 py-2">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted hover:text-primary"
            onClick={() => onScanQr(video.path)}
            disabled={qrBusy}
            title={t("media.list.scanQrClip")}
            aria-label={t("media.list.scanQr")}
          >
            <QrCode className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted hover:text-destructive"
            onClick={() => onRemove(video.path)}
            title={t("common.actions.remove")}
            aria-label={t("common.actions.remove")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export type MediaListPanelProps = {
  kind: "video" | "foto";
  disabled?: boolean;
  onRemoveVideo?: (path: string) => void;
  onCutVideo?: (path: string) => void;
  onUndoVideoCut?: (path: string) => void;
};

/** Dense meta/action list under the Video/Foto preview (reorder, WM, QR, remove). */
export function MediaListPanel({
  kind,
  disabled = false,
  onRemoveVideo,
  onCutVideo,
  onUndoVideoCut,
}: MediaListPanelProps) {
  const { t } = useTranslation();
  const videoList = useVideoStore((s) => s.videoList);
  const getCutMark = useVideoStore((s) => s.getCutMark);
  const cutMarks = useVideoStore((s) => s.cutMarks);
  const removeVideo = useVideoStore((s) => s.removeVideo);
  const reorderVideos = useVideoStore((s) => s.reorderVideos);
  const sortVideos = useVideoStore((s) => s.sortVideos);
  const listSort = useVideoStore((s) => s.listSort);
  const watermarkClipIndex = useVideoStore((s) => s.watermarkClipIndex);
  const toggleWatermarkClip = useVideoStore((s) => s.toggleWatermarkClip);

  const photoList = usePhotoStore((s) => s.photoList);
  const removePhotos = usePhotoStore((s) => s.removePhotos);
  const watermarkPhotoIndices = usePhotoStore((s) => s.watermarkIndices);
  const togglePhotoWatermark = usePhotoStore((s) => s.toggleWatermark);
  const setCurrentIndex = usePhotoStore((s) => s.setCurrentIndex);

  const kunde = useKundeStore((s) => s.kunde);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);

  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);
  const [qrBusy, setQrBusy] = useState(false);

  const videoWmNeeded =
    (kunde.handcam_video && !kunde.ist_bezahlt_handcam_video) ||
    (kunde.outside_video && !kunde.ist_bezahlt_outside_video);
  const fotoWmNeeded =
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto) ||
    (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto);

  const busy = disabled || qrBusy;

  function openMediaMenu(e: MouseEvent, path: string) {
    mediaContextMenuHandler(path, setCtxMenu)(e);
  }

  function toggleVideoColumnSort(key: "name" | "duration" | "size") {
    const nextAsc = listSort?.key === key ? !listSort.asc : true;
    sortVideos(key, nextAsc);
  }

  async function scanVideoQr(path: string) {
    setQrBusy(true);
    try {
      const result = await withQrScanProgress([path], () => scanQrVideo(path));
      if (result.cancelled) {
        showWarning(result.message, t("media.drop.qrScanTitle"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path ?? path,
          preview: result.preview,
          runCleanup: () =>
            maybeRemoveQrVideo(result.source_path ?? path, {
              onBeforeRemove: (p) => onRemoveVideo?.(p),
            }),
        });
      } else {
        showWarning(result.message || t("media.list.noQrClip"), t("media.drop.qrScanTitle"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("media.drop.qrScanTitle"));
      requestKundenIdFocus();
    } finally {
      setQrBusy(false);
    }
  }

  async function scanPhotoQr(path: string) {
    setQrBusy(true);
    try {
      const result = await withQrScanProgress([path], () => scanQrPhoto(path));
      if (result.cancelled) {
        showWarning(result.message, t("media.drop.qrScanTitle"), { autoCloseSecs: 5 });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          sourcePath: result.source_path ?? path,
          preview: result.preview,
          runCleanup: () => maybeRemoveQrPhoto(result.source_path ?? path),
        });
      } else {
        showWarning(result.message || t("media.list.noQrPhoto"), t("media.drop.qrScanTitle"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e), t("media.drop.qrScanTitle"));
      requestKundenIdFocus();
    } finally {
      setQrBusy(false);
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorderVideos(String(active.id), String(over.id));
  }

  if (kind === "video") {
    if (videoList.length === 0) {
      return (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
          {t("media.list.emptyVideos")}
        </p>
      );
    }

    return (
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("media.list.title")}
          </h3>
          <p className="text-[11px] text-muted">
            {t("media.list.hintVideos")}
          </p>
        </div>
        <div className="max-h-[18rem] overflow-auto rounded-lg border border-border bg-card">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <table className="w-full border-collapse">
              <thead>
                <tr className="sticky top-0 z-[1] border-b border-border bg-card-elevated text-left text-xs font-semibold tracking-wide text-muted uppercase">
                  <th className="px-2 py-2" aria-label={t("media.list.sortAria")} />
                  <th className="px-1 py-2">#</th>
                  <th className="px-2 py-2">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                        listSort?.key === "name" && "text-foreground",
                      )}
                      onClick={() => toggleVideoColumnSort("name")}
                      title={t("media.list.sortByName")}
                    >
                      {t("media.list.filename")}
                      {listSort?.key === "name" ? (
                        listSort.asc ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  </th>
                  <th className="px-2 py-2">{t("media.list.format")}</th>
                  <th className="px-2 py-2">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                        listSort?.key === "duration" && "text-foreground",
                      )}
                      onClick={() => toggleVideoColumnSort("duration")}
                      title={t("media.list.sortByDuration")}
                    >
                      {t("media.list.duration")}
                      {listSort?.key === "duration" ? (
                        listSort.asc ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-0.5 py-0.5 hover:text-foreground",
                        listSort?.key === "size" && "text-foreground",
                      )}
                      onClick={() => toggleVideoColumnSort("size")}
                      title={t("media.list.sortBySize")}
                    >
                      {t("media.list.size")}
                      {listSort?.key === "size" ? (
                        listSort.asc ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  </th>
                  <th className="px-2 py-2">{t("media.list.codec")}</th>
                  {videoWmNeeded ? (
                    <th className="px-1 py-2 text-center" title={t("media.list.watermark")}>
                      WM
                    </th>
                  ) : null}
                  <th className="px-1 py-2 text-right" aria-label={t("media.list.actions")}>
                    <span className="sr-only">{t("media.list.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <SortableContext
                  items={videoList.map((v) => v.path)}
                  strategy={verticalListSortingStrategy}
                >
                  {videoList.map((v, i) => {
                    void cutMarks;
                    return (
                      <SortableVideoRow
                        key={v.path}
                        video={v}
                        index={i}
                        qrBusy={busy}
                        showWatermark={videoWmNeeded}
                        watermarkSelected={watermarkClipIndex === i}
                        onToggleWatermark={toggleWatermarkClip}
                        cutMark={getCutMark(v.path)}
                        onScanQr={(path) => void scanVideoQr(path)}
                        onContextMenu={openMediaMenu}
                        onRemove={(path) => {
                          onRemoveVideo?.(path);
                          removeVideo(path);
                        }}
                      />
                    );
                  })}
                </SortableContext>
              </tbody>
            </table>
          </DndContext>
        </div>
        <MediaFileContextMenu
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onError={(msg) => showError(msg, t("media.list.fileTitle"))}
          onCopied={() => showSuccess(t("media.list.pathCopied"), t("media.list.pathTitle"))}
          actionsDisabled={busy}
          onScanQr={(path) => void scanVideoQr(path)}
          onCut={onCutVideo}
          canUndoCut={Boolean(ctxMenu && getCutMark(ctxMenu.path))}
          onUndoCut={onUndoVideoCut}
          onRemove={(path) => {
            onRemoveVideo?.(path);
            removeVideo(path);
          }}
        />
      </div>
    );
  }

  if (photoList.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
        {t("media.list.emptyPhotos")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("media.list.title")}
        </h3>
        <p className="text-[11px] text-muted">{t("media.list.hintPhotos")}</p>
      </div>
      <div className="max-h-[18rem] overflow-auto rounded-lg border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="sticky top-0 z-[1] border-b border-border bg-card-elevated text-left text-xs font-semibold tracking-wide text-muted uppercase">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">{t("media.list.filename")}</th>
              <th className="px-2 py-2">{t("media.list.format")}</th>
              <th className="px-2 py-2">{t("media.list.size")}</th>
              {fotoWmNeeded ? (
                <th className="px-1 py-2 text-center" title={t("media.list.watermark")}>
                      WM
                </th>
              ) : null}
              <th className="px-1 py-2 text-right" aria-label={t("media.list.actions")}>
                <span className="sr-only">{t("media.list.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {photoList.map((p, i) => {
              const device = formatCameraLabel(p.camera_make, p.camera_model);
              return (
                <tr
                  key={p.path}
                  className="cursor-pointer border-b border-border/70 text-sm last:border-0 hover:bg-card-elevated/60"
                  onClick={() => setCurrentIndex(i)}
                  onContextMenu={(e) => openMediaMenu(e, p.path)}
                >
                  <td className="w-8 px-2 py-2 tabular-nums text-muted">{i + 1}</td>
                  <td className="max-w-[20rem] px-2 py-2 font-medium" title={p.path}>
                    <div className="truncate">{p.filename}</div>
                    {device ? (
                      <div className="truncate text-xs text-muted" title={device}>
                        {device}
                      </div>
                    ) : null}
                    <QrScanRowBar path={p.path} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-muted">
                    {photoFormatLabel(p.width, p.height)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                    {p.sizeBytes != null && p.sizeBytes > 0
                      ? formatSize(p.sizeBytes)
                      : "—"}
                  </td>
                  {fotoWmNeeded ? (
                    <td
                      className="w-10 px-1 py-2 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={watermarkPhotoIndices.has(i)}
                        onCheckedChange={() => togglePhotoWatermark(i)}
                        aria-label={t("media.list.wmPhotoAria")}
                        title={t("media.list.wmPhotoTitle")}
                      />
                    </td>
                  ) : null}
                  <td
                    className="w-[4.5rem] px-1 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted hover:text-primary"
                        onClick={() => void scanPhotoQr(p.path)}
                        disabled={busy}
                        title={t("media.list.scanQrPhoto")}
                        aria-label={t("media.list.scanQr")}
                      >
                        <QrCode className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted hover:text-destructive"
                        onClick={() => {
                          const idx = photoList.findIndex((x) => x.path === p.path);
                          if (idx >= 0) removePhotos([idx]);
                        }}
                        title={t("common.actions.remove")}
                        aria-label={t("common.actions.remove")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, t("media.list.fileTitle"))}
        onCopied={() => showSuccess(t("media.list.pathCopied"), t("media.list.pathTitle"))}
        actionsDisabled={busy}
        onScanQr={(path) => void scanPhotoQr(path)}
        onRemove={(path) => {
          const idx = photoList.findIndex((p) => p.path === path);
          if (idx >= 0) removePhotos([idx]);
        }}
      />
    </div>
  );
}
