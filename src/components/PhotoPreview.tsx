import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ThumbQuality } from "../lib/sdCard";
import {
  PHOTO_THUMB_PRIORITY,
  photoThumbnailQueue,
} from "../lib/photoThumbnailQueue";
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Loader2,
  Pencil,
  QrCode,
  RotateCcw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useUiStore } from "../store/uiStore";
import { useQrScanStore, withQrScanProgress } from "../store/qrScanStore";
import { scanQrPhoto } from "../lib/tauri";
import { maybeRemoveQrPhoto } from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import { requestKundenIdFocus } from "../lib/kundenIdFocus";
import { QrScanRowBar } from "../hooks/useQrScanProgress";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn } from "../lib/utils";
import { CREATE_READY_IDS } from "../lib/createReadyHints";

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

function photoFileSrcFallback(path: string, revision: number): string {
  const base = convertFileSrc(path);
  return `${base}${base.includes("?") ? "&" : "?"}r=${revision}`;
}

/**
 * Queued thumbnail (OPT-11): strip/warm share limited concurrent jobs;
 * main stage uses file src + low-priority preview upgrade (strip wins).
 */
function usePhotoThumbnailSrc(
  path: string | null,
  quality: ThumbQuality,
  revision: number,
  priority: number,
  opts?: { enabled?: boolean },
): string | null {
  const enabled = opts?.enabled !== false;
  const [url, setUrl] = useState<string | null>(() =>
    path && enabled
      ? photoThumbnailQueue.getCached(path, quality, revision)
      : null,
  );

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    const cached = photoThumbnailQueue.getCached(path, quality, revision);
    if (!enabled) {
      // Keep last paint / cache; do not start a strip fetch while offscreen.
      if (cached) setUrl(cached);
      return;
    }
    let cancelled = false;
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);

    void photoThumbnailQueue
      .request(path, quality, priority, revision)
      .then((displayUrl) => {
        if (!cancelled) setUrl(displayUrl || photoFileSrcFallback(path, revision));
      })
      .catch(() => {
        if (!cancelled) setUrl(photoFileSrcFallback(path, revision));
      });

    return () => {
      cancelled = true;
    };
  }, [path, quality, revision, priority, enabled]);

  return url;
}

type PhotoStripThumbProps = {
  path: string;
  filename: string;
  revision: number;
  isCurrent: boolean;
  isSelected: boolean;
  isWm: boolean;
  editMark: "crop" | "rotate" | null;
  stripRootRef: RefObject<HTMLDivElement | null>;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
};

function rectNearlyIntersects(
  el: DOMRect,
  root: DOMRect,
  marginX: number,
  marginY: number,
): boolean {
  return (
    el.right >= root.left - marginX &&
    el.left <= root.right + marginX &&
    el.bottom >= root.top - marginY &&
    el.top <= root.bottom + marginY
  );
}

function PhotoStripThumb({
  path,
  filename,
  revision,
  isCurrent,
  isSelected,
  isWm,
  editMark,
  stripRootRef,
  onClick,
  onContextMenu,
}: PhotoStripThumbProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;

    let io: IntersectionObserver | null = null;
    let cancelled = false;
    const marginX = 100;
    const marginY = 160;

    const applyGeometry = (root: Element | null) => {
      const er = el.getBoundingClientRect();
      if (root) {
        setInView(
          rectNearlyIntersects(er, root.getBoundingClientRect(), marginX, marginY),
        );
        return;
      }
      const vr = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      } as DOMRect;
      setInView(rectNearlyIntersects(er, vr, marginX, marginY));
    };

    const connect = () => {
      if (cancelled) return;
      const root = stripRootRef.current;
      io?.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            setInView(entry.isIntersecting);
          }
        },
        {
          root: root ?? null,
          rootMargin: `${marginY}px ${marginX}px`,
          threshold: 0.01,
        },
      );
      io.observe(el);
      const records = io.takeRecords();
      if (records.length > 0) {
        setInView(records.some((r) => r.isIntersecting));
      } else {
        applyGeometry(root);
      }
    };

    connect();
    // Root ref / layout may settle one frame later after import.
    const raf = window.requestAnimationFrame(connect);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [stripRootRef, path]);

  const loading = isCurrent || inView;
  const stripPriority = loading
    ? PHOTO_THUMB_PRIORITY.visible
    : PHOTO_THUMB_PRIORITY.warm;
  const thumbSrc = usePhotoThumbnailSrc(path, "lq", revision, stripPriority, {
    enabled: loading,
  });

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-thumb-path={path}
      aria-busy={loading && !thumbSrc ? true : undefined}
      className={cn(
        "relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-card transition",
        isSelected
          ? "border-primary ring-2 ring-primary/25"
          : isCurrent
            ? "border-foreground/40"
            : "border-transparent opacity-80 hover:opacity-100",
      )}
      title={isWm ? `${filename} (Wasserzeichen)` : filename}
    >
      {thumbSrc ? (
        <img
          src={thumbSrc}
          alt={filename}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center bg-muted/40"
          aria-hidden
        >
          {loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/80" />
          )}
        </div>
      )}
      {editMark && (
        <span className="absolute left-0.5 top-0.5 rounded bg-sky-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm">
          {editMark === "crop" ? "Crop" : "Rot"}
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-0.5 pb-0.5">
        <QrScanRowBar path={path} />
      </div>
      {isWm && (
        <>
          <img
            src="/preview_stempel.png"
            alt=""
            className="pointer-events-none absolute left-1/2 top-1/2 max-h-[135%] max-w-[135%] -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-sm"
          />
          <span
            className="absolute top-0.5 right-0.5 rounded bg-amber-500 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
            aria-label="Wasserzeichen"
          >
            WM
          </span>
        </>
      )}
    </button>
  );
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
  const stripRootRef = useRef<HTMLDivElement>(null);

  const current = currentIndex >= 0 ? photoList[currentIndex] : null;

  const fotoWmNeeded =
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto) ||
    (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto);

  const effectiveSelection = useMemo(() => {
    if (explicitlySelected && selected.size > 0) return selected;
    if (currentIndex >= 0) return new Set([currentIndex]);
    return new Set<number>();
  }, [explicitlySelected, selected, currentIndex]);

  const totalSizeHint = useMemo(() => {
    const sum = photoList.reduce((acc, p) => acc + (p.sizeBytes || 0), 0);
    return formatBytes(sum || undefined);
  }, [photoList]);

  useEffect(() => {
    const missing = photoList.some((p) => p.sizeBytes == null);
    if (missing) void refreshSizes();
  }, [photoList, refreshSizes]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  }, [currentIndex, setCurrentIndex]);

  const goNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < photoList.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, photoList.length, setCurrentIndex]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (disabled) return;
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
    goPrev,
    goNext,
    effectiveSelection,
    removePhotos,
    photoList,
    toggleSelect,
  ]);

  async function handleQrScan(path?: string) {
    const photo = path
      ? photoList.find((p) => p.path === path)
      : current;
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
  // File src fills the stage; preview thumb upgrades at low priority so strip LQ wins.
  const previewSrc = usePhotoThumbnailSrc(
    current?.path ?? null,
    "preview",
    currentRevision,
    PHOTO_THUMB_PRIORITY.stageUpgrade,
    { enabled: Boolean(current) && !qrScanBusy },
  );
  const stageSrc = current
    ? (previewSrc ?? photoFileSrcFallback(current.path, currentRevision))
    : null;

  // Subscribe so revision bumps re-render thumbs.
  void editMarks;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ImageIcon className="h-4 w-4 text-primary" />
          {t("photo.preview.title")}
        </h3>
      </div>

      <div
        className="relative aspect-video w-full overflow-hidden rounded-xl bg-[var(--ats-preview-stage)] ring-1 ring-border"
        tabIndex={0}
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
            {!previewSrc && qrScanBusy && (
              <div
                className="pointer-events-none absolute bottom-2 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 rounded-md bg-black/50 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur-sm"
                role="status"
              >
                <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-80" aria-hidden />
                <span>{t("photo.preview.loadingQr")}</span>
              </div>
            )}
            {photoList.length > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                  onClick={goPrev}
                  disabled={currentIndex <= 0}
                  aria-label={t("photo.preview.prevPhotoAria")}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                  onClick={goNext}
                  disabled={currentIndex >= photoList.length - 1}
                  aria-label={t("photo.preview.nextPhotoAria")}
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

      {photoList.length > 0 && (
        <div ref={stripRootRef} className="flex gap-2 overflow-x-auto pb-5">
          {photoList.map((p, i) => {
            const isCurrent = i === currentIndex;
            const isSelected = explicitlySelected && selected.has(i);
            const isWm = fotoWmNeeded && watermarkIndices.has(i);
            return (
              <PhotoStripThumb
                key={p.path}
                path={p.path}
                filename={p.filename}
                revision={getMediaRevision(p.path)}
                isCurrent={isCurrent}
                isSelected={isSelected}
                isWm={isWm}
                editMark={getEditMark(p.path)}
                stripRootRef={stripRootRef}
                onClick={(e) => onThumbClick(i, e)}
                onContextMenu={mediaContextMenuHandler(p.path, setCtxMenu)}
              />
            );
          })}
        </div>
      )}

      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="flex flex-col rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">{t("photo.preview.currentPhoto")}</p>
          {current ? (
            <dl className="space-y-0.5 text-muted">
              <div>
                <dt className="inline text-foreground">Datei: </dt>
                <dd className="inline break-all">{current.filename}</dd>
              </div>
              <div>Größe: {formatBytes(current.sizeBytes)}</div>
              <div>
                Position: {currentIndex + 1} / {photoList.length}
              </div>
              {(current.camera_make || current.camera_model) && (
                <div>
                  Kamera:{" "}
                  {[current.camera_make, current.camera_model]
                    .filter(Boolean)
                    .join(" ")}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-muted">—</p>
          )}
          {current && fotoWmNeeded && (
            <button
              type="button"
              disabled={disabled}
              aria-pressed={watermarkIndices.has(currentIndex)}
              aria-label="Preview-Foto mit Wasserzeichen-Stempel"
              onClick={() => toggleWatermark(currentIndex)}
              className={cn(
                "mt-2 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                watermarkIndices.has(currentIndex)
                  ? "border-amber-500/50 bg-amber-500/15 ring-1 ring-inset ring-amber-500/30"
                  : "border-border/60 bg-background/40 hover:border-border hover:bg-background/70",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">
                  Preview
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                  Mit Wasserzeichen-Stempel exportieren
                </span>
              </span>
              <Checkbox
                checked={watermarkIndices.has(currentIndex)}
                tabIndex={-1}
                aria-hidden
                className={cn(
                  "pointer-events-none h-6 w-6 [&_svg]:h-4 [&_svg]:w-4",
                  watermarkIndices.has(currentIndex) &&
                    "border-amber-500 data-[state=checked]:border-amber-500 data-[state=checked]:bg-amber-500",
                )}
              />
            </button>
          )}
          {current && (
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled || !onEditPhoto}
                onClick={() => onEditPhoto?.(current.path)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Bearbeiten
              </Button>
              {getEditMark(current.path) && onUndoPhotoEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onUndoPhotoEdit(current.path)}
                  title={t("photo.preview.undoThisEditTitle")}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Bearbeitung rückgängig
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled || scanning}
                onClick={() => void handleQrScan()}
              >
                <QrCode className="h-3.5 w-3.5" />
                QR scannen
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disabled || effectiveSelection.size === 0}
                onClick={() => removePhotos([...effectiveSelection])}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {effectiveSelection.size > 1
                  ? `${effectiveSelection.size} Entfernen`
                  : "Entfernen"}
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-col rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">{t("photo.preview.total")}</p>
          <dl className="space-y-0.5 text-muted">
            <div>Anzahl: {photoList.length}</div>
            <div>Größe: {totalSizeHint}</div>
            {fotoWmNeeded && (
              <div
                id={CREATE_READY_IDS.watermark}
                tabIndex={-1}
                className="outline-none"
              >
                Wasserzeichen: {watermarkIndices.size} / {photoList.length}
              </div>
            )}
          </dl>
          {explicitlySelected && selected.size > 0 && (
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              {onBatchRotate && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() =>
                      onBatchRotate(
                        [...selected]
                          .map((i) => photoList[i]?.path)
                          .filter((p): p is string => Boolean(p)),
                        -90,
                      )
                    }
                    title="Auswahl 90° gegen den Uhrzeigersinn"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Auswahl 90°
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() =>
                      onBatchRotate(
                        [...selected]
                          .map((i) => photoList[i]?.path)
                          .filter((p): p is string => Boolean(p)),
                        90,
                      )
                    }
                    title="Auswahl 90° im Uhrzeigersinn"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Auswahl 90°
                  </Button>
                </>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={clearSelection}
              >
                Auswahl aufheben
              </Button>
            </div>
          )}
        </div>
      </div>

      <MediaFileContextMenu
        state={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onError={(msg) => showError(msg, t("media.list.fileTitle"))}
        onCopied={() => showSuccess(t("media.list.pathCopied"), t("media.list.pathTitle"))}
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
