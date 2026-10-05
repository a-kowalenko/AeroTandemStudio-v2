import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Minimize2,
} from "lucide-react";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useUiStore } from "../store/uiStore";
import { useQrScanStore, withQrScanProgress } from "../store/qrScanStore";
import { scanQrPhoto } from "../lib/tauri";
import { maybeRemoveQrPhoto } from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import { requestKundenIdFocus } from "../lib/kundenIdFocus";
import { PHOTO_THUMB_PRIORITY } from "../lib/photoThumbnailQueue";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn } from "../lib/utils";
import { PhotoOverviewGrid } from "./photo/PhotoOverviewGrid";
import { PhotoDetailPanel } from "./photo/PhotoDetailPanel";
import {
  photoFileSrcFallback,
  usePhotoThumbnailSrc,
} from "./photo/usePhotoThumbnailSrc";

/** ≤ this count → large stage open by default (former Review default). */
const AUTO_EXPAND_THRESHOLD = 8;
/** Match Tailwind `lg` — side-by-side overview + detail panel. */
const PHOTO_OVERVIEW_LG_MQ = "(min-width: 1024px)";
/** Sensible floor so the thumb grid stays usable (~2 rows). */
const PHOTO_OVERVIEW_MIN_PX = 256;

type PhotoPreviewProps = {
  disabled?: boolean;
  onEditPhoto?: (path: string) => void;
  onUndoPhotoEdit?: (path: string) => void;
  onBatchRotate?: (paths: string[], degrees: number) => void;
};

function formatBytes(n: number | undefined): string {
  if (n == null || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function PhotoPreview({
  disabled,
  onEditPhoto,
  onUndoPhotoEdit,
  onBatchRotate,
}: PhotoPreviewProps) {
  const { t } = useTranslation();
  const photoList = usePhotoStore((s) => s.photoList);
  const currentIndex = usePhotoStore((s) => s.currentIndex);
  const selected = usePhotoStore((s) => s.selected);
  const explicitlySelected = usePhotoStore((s) => s.explicitlySelected);
  const watermarkIndices = usePhotoStore((s) => s.watermarkIndices);
  const getEditMark = usePhotoStore((s) => s.getEditMark);
  const getMediaRevision = usePhotoStore((s) => s.getMediaRevision);
  const editMarks = usePhotoStore((s) => s.editMarks);
  const removePhotos = usePhotoStore((s) => s.removePhotos);
  const setCurrentIndex = usePhotoStore((s) => s.setCurrentIndex);
  const toggleSelect = usePhotoStore((s) => s.toggleSelect);
  const clearSelection = usePhotoStore((s) => s.clearSelection);
  const toggleWatermark = usePhotoStore((s) => s.toggleWatermark);
  const refreshSizes = usePhotoStore((s) => s.refreshSizes);

  const kunde = useKundeStore((s) => s.kunde);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);
  const qrScanBusy = useQrScanStore((s) => s.busy);

  const [scanning, setScanning] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);
  /** `null` = auto by count; user expand/collapse sets an override. */
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );
  const detailPanelRef = useRef<HTMLElement>(null);
  const [detailPanelHeight, setDetailPanelHeight] = useState<number | null>(
    null,
  );
  const [isLgOverviewRow, setIsLgOverviewRow] = useState(false);

  const current = currentIndex >= 0 ? photoList[currentIndex] : null;
  const autoExpanded =
    photoList.length > 0 && photoList.length <= AUTO_EXPAND_THRESHOLD;
  const overviewExpanded = expandedOverride ?? autoExpanded;

  const fotoWmNeeded =
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto) ||
    (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto);

  const effectiveSelection = useMemo(() => {
    if (explicitlySelected && selected.size > 0) return selected;
    if (currentIndex >= 0) return new Set([currentIndex]);
    return new Set<number>();
  }, [explicitlySelected, selected, currentIndex]);

  const selectedIndices = useMemo(
    () => (explicitlySelected ? [...selected].sort((a, b) => a - b) : []),
    [explicitlySelected, selected],
  );

  const totalSizeHint = useMemo(() => {
    const sum = photoList.reduce((acc, p) => acc + (p.sizeBytes || 0), 0);
    return formatBytes(sum || undefined);
  }, [photoList]);

  useEffect(() => {
    const missing = photoList.some((p) => p.sizeBytes == null);
    if (missing) void refreshSizes();
  }, [photoList, refreshSizes]);

  useEffect(() => {
    const mq = window.matchMedia(PHOTO_OVERVIEW_LG_MQ);
    const sync = () => setIsLgOverviewRow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (photoList.length === 0) setExpandedOverride(null);
  }, [photoList.length]);

  useEffect(() => {
    if (!isLgOverviewRow) {
      setDetailPanelHeight(null);
      return;
    }
    const el = detailPanelRef.current;
    if (!el) return;
    const sync = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setDetailPanelHeight(h);
    };
    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    isLgOverviewRow,
    overviewExpanded,
    photoList.length,
    currentIndex,
    explicitlySelected,
    selectedIndices.length,
    fotoWmNeeded,
  ]);

  const overviewGridStyle = useMemo(() => {
    if (!isLgOverviewRow || detailPanelHeight == null) {
      return undefined;
    }
    return {
      height: Math.max(PHOTO_OVERVIEW_MIN_PX, detailPanelHeight),
    };
  }, [isLgOverviewRow, detailPanelHeight]);

  const overviewGridClassName =
    isLgOverviewRow && detailPanelHeight != null ? "max-h-none" : undefined;

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  }, [currentIndex, setCurrentIndex]);

  const goNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < photoList.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, photoList.length, setCurrentIndex]);

  const expandPreview = useCallback(() => setExpandedOverride(true), []);
  const collapsePreview = useCallback(() => setExpandedOverride(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key === "Escape" && overviewExpanded) {
        e.preventDefault();
        collapsePreview();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "Delete" && effectiveSelection.size > 0) {
        e.preventDefault();
        removePhotos([...effectiveSelection]);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        for (let i = 0; i < photoList.length; i++) {
          toggleSelect(i, i === 0 ? "replace" : "toggle");
        }
        const all = new Set(photoList.map((_, i) => i));
        usePhotoStore.setState({ selected: all, explicitlySelected: true });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    disabled,
    overviewExpanded,
    collapsePreview,
    goPrev,
    goNext,
    effectiveSelection,
    removePhotos,
    photoList,
    toggleSelect,
  ]);

  async function handleQrScan(path?: string) {
    const photo = path ? photoList.find((p) => p.path === path) : current;
    if (!photo) return;
    setScanning(true);
    try {
      const result = await withQrScanProgress([photo.path], () =>
        scanQrPhoto(photo.path),
      );
      if (result.cancelled) {
        showWarning(result.message || t("app.qr.cancelled"), t("app.qr.label"), {
          autoCloseSecs: 5,
        });
      } else if (result.found && result.kunde) {
        await presentQrHit({
          kunde: result.kunde,
          dualFamily: result.dual_family,
          numericIds: result.numeric_ids,
          sourcePath: result.source_path ?? photo.path,
          preview: result.preview,
          runCleanup: () => maybeRemoveQrPhoto(result.source_path ?? photo.path),
        });
      } else {
        showError(result.message || t("app.qr.notFound"));
        requestKundenIdFocus();
      }
    } catch (e) {
      showError(String(e));
      requestKundenIdFocus();
    } finally {
      setScanning(false);
    }
  }

  function onThumbClick(index: number, e: MouseEvent) {
    if (e.shiftKey) {
      toggleSelect(index, "range");
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(index, "toggle");
      return;
    }
    toggleSelect(index, "replace");
  }

  const currentRevision = current ? getMediaRevision(current.path) : 0;
  const previewSrc = usePhotoThumbnailSrc(
    current?.path ?? null,
    "preview",
    currentRevision,
    PHOTO_THUMB_PRIORITY.stageUpgrade,
    {
      enabled: Boolean(current) && overviewExpanded && !qrScanBusy,
    },
  );
  const stageSrc = current
    ? (previewSrc ?? photoFileSrcFallback(current.path, currentRevision))
    : null;

  void editMarks;

  const photoPathsByIndex = useCallback(
    (indices: number[]) =>
      indices
        .map((i) => photoList[i]?.path)
        .filter((p): p is string => Boolean(p)),
    [photoList],
  );

  const contextMenuFor = useCallback(
    (path: string) => mediaContextMenuHandler(path, setCtxMenu),
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ImageIcon className="h-4 w-4 text-primary" />
          {t("photo.preview.title")}
        </h3>
      </div>

      <div
        className={cn(
          "grid min-h-0 transition-[grid-template-rows,gap] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          overviewExpanded
            ? "grid-rows-[1fr_auto] gap-3"
            : "grid-rows-[0fr_auto] gap-0",
        )}
      >
        <div
          className={cn(
            "min-h-0 overflow-hidden transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            overviewExpanded
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
          aria-hidden={!overviewExpanded}
        >
          <div
            className="relative aspect-video w-full overflow-hidden rounded-xl bg-[var(--ats-preview-stage)] ring-1 ring-border"
            tabIndex={overviewExpanded ? 0 : -1}
            onContextMenu={
              current
                ? mediaContextMenuHandler(current.path, setCtxMenu)
                : undefined
            }
          >
            {stageSrc ? (
              <>
                <img
                  src={stageSrc}
                  alt={current?.filename ?? t("common.labels.photo")}
                  className="h-full w-full object-contain"
                />
                <button
                  type="button"
                  className="absolute right-2 top-2 z-[1] rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                  onClick={collapsePreview}
                  aria-label={t("photo.preview.collapsePreviewAria")}
                  tabIndex={overviewExpanded ? 0 : -1}
                >
                  <Minimize2 className="h-4 w-4" aria-hidden />
                </button>
                {photoList.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="absolute left-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                      onClick={goPrev}
                      disabled={currentIndex <= 0}
                      aria-label={t("photo.preview.prevPhotoAria")}
                      tabIndex={overviewExpanded ? 0 : -1}
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                      onClick={goNext}
                      disabled={currentIndex >= photoList.length - 1}
                      aria-label={t("photo.preview.nextPhotoAria")}
                      tabIndex={overviewExpanded ? 0 : -1}
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-white/75">
                <ImageIcon className="h-8 w-8 opacity-50" aria-hidden />
                <p>{t("photo.preview.empty")}</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3 lg:flex-row lg:items-start">
          <PhotoDetailPanel
            ref={detailPanelRef}
            current={current ?? null}
            currentIndex={currentIndex}
            photoCount={photoList.length}
            totalSizeHint={totalSizeHint}
            fotoWmNeeded={fotoWmNeeded}
            watermarkCount={watermarkIndices.size}
            isCurrentWm={
              currentIndex >= 0 && watermarkIndices.has(currentIndex)
            }
            editMark={current ? getEditMark(current.path) : null}
            revision={currentRevision}
            qrScanBusy={qrScanBusy}
            scanning={scanning}
            disabled={disabled}
            showMiniPreview
            miniPreviewCollapsed={overviewExpanded}
            effectiveSelectionSize={effectiveSelection.size}
            explicitlySelected={explicitlySelected}
            selectedIndices={selectedIndices}
            photoPathsByIndex={photoPathsByIndex}
            onExpandPreview={current ? expandPreview : undefined}
            onToggleWatermark={() => toggleWatermark(currentIndex)}
            onEditPhoto={onEditPhoto}
            onUndoPhotoEdit={onUndoPhotoEdit}
            onBatchRotate={onBatchRotate}
            onScanQr={() => void handleQrScan()}
            onRemove={() => removePhotos([...effectiveSelection])}
            onClearSelection={clearSelection}
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <PhotoOverviewGrid
              className={overviewGridClassName}
              style={overviewGridStyle}
              photos={photoList}
              currentIndex={currentIndex}
              selected={selected}
              explicitlySelected={explicitlySelected}
              watermarkIndices={watermarkIndices}
              fotoWmNeeded={fotoWmNeeded}
              getEditMark={getEditMark}
              getMediaRevision={getMediaRevision}
              onThumbClick={onThumbClick}
              onContextMenu={contextMenuFor}
            />
          </div>
        </div>
      </div>

      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, t("media.list.fileTitle"))}
        onCopied={() =>
          showSuccess(t("media.list.pathCopied"), t("media.list.pathTitle"))
        }
        actionsDisabled={disabled || scanning}
        onScanQr={(path) => void handleQrScan(path)}
        onCut={onEditPhoto}
        canUndoCut={Boolean(ctxMenu && getEditMark(ctxMenu.path))}
        onUndoCut={onUndoPhotoEdit}
        onRemove={(path) => {
          const idx = photoList.findIndex((p) => p.path === path);
          if (idx >= 0) removePhotos([idx]);
        }}
      />
    </div>
  );
}
