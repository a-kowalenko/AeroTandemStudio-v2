import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, ImageIcon, QrCode, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { usePhotoStore } from "../store/photoStore";
import { useKundeStore } from "../store/kundeStore";
import { useUiStore } from "../store/uiStore";
import { withQrScanProgress } from "../store/qrScanStore";
import { scanQrPhoto } from "../lib/tauri";
import { maybeRemoveQrPhoto } from "../lib/qrCleanup";
import { presentQrHit } from "../lib/qrPresent";
import { QrScanRowBar } from "../hooks/useQrScanProgress";
import {
  MediaFileContextMenu,
  mediaContextMenuHandler,
  type MediaContextMenuState,
} from "./MediaFileContextMenu";
import { cn } from "../lib/utils";

type PhotoPreviewProps = {
  disabled?: boolean;
};

function formatBytes(n: number | undefined): string {
  if (n == null || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function PhotoPreview({ disabled }: PhotoPreviewProps) {
  const photoList = usePhotoStore((s) => s.photoList);
  const currentIndex = usePhotoStore((s) => s.currentIndex);
  const selected = usePhotoStore((s) => s.selected);
  const explicitlySelected = usePhotoStore((s) => s.explicitlySelected);
  const watermarkIndices = usePhotoStore((s) => s.watermarkIndices);
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

  const [scanning, setScanning] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MediaContextMenuState | null>(null);

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
        showWarning(result.message || "QR-Scan abgebrochen.", "QR-Scan", {
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
        showError(result.message || "Kein QR-Code gefunden.");
      }
    } catch (e) {
      showError(String(e));
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

  const previewSrc = current ? convertFileSrc(current.path) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ImageIcon className="h-4 w-4 text-primary" />
          Foto-Vorschau
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
        {previewSrc ? (
          <>
            <img
              src={previewSrc}
              alt={current?.filename ?? "Foto"}
              className="h-full w-full object-contain"
            />
            {photoList.length > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                  onClick={goPrev}
                  disabled={currentIndex <= 0}
                  aria-label="Vorheriges Foto"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-black/45 p-2 text-white backdrop-blur-sm transition hover:bg-black/65"
                  onClick={goNext}
                  disabled={currentIndex >= photoList.length - 1}
                  aria-label="Nächstes Foto"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-white/75">
            <ImageIcon className="h-8 w-8 opacity-50" aria-hidden />
            <p>Keine Fotos — per Drag & Drop im Medien-Bereich hinzufügen</p>
          </div>
        )}
      </div>

      {photoList.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-5">
          {photoList.map((p, i) => {
            const isCurrent = i === currentIndex;
            const isSelected = explicitlySelected && selected.has(i);
            const isWm = fotoWmNeeded && watermarkIndices.has(i);
            return (
              <button
                key={p.path}
                type="button"
                onClick={(e) => onThumbClick(i, e)}
                onContextMenu={mediaContextMenuHandler(p.path, setCtxMenu)}
                className={cn(
                  "relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-card transition",
                  isSelected
                    ? "border-primary ring-2 ring-primary/25"
                    : isCurrent
                      ? "border-foreground/40"
                      : "border-transparent opacity-80 hover:opacity-100",
                )}
                title={isWm ? `${p.filename} (Wasserzeichen)` : p.filename}
              >
                <img
                  src={convertFileSrc(p.path)}
                  alt={p.filename}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 px-0.5 pb-0.5">
                  <QrScanRowBar path={p.path} />
                </div>
                {isWm && (
                  <span
                    className="absolute top-0.5 right-0.5 rounded bg-amber-500 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
                    aria-label="Wasserzeichen"
                  >
                    WM
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="flex flex-col rounded-lg border border-border/60 bg-card-elevated/80 p-3">
          <p className="mb-1 font-semibold">Aktuelles Foto</p>
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
          <p className="mb-1 font-semibold">Gesamt</p>
          <dl className="space-y-0.5 text-muted">
            <div>Anzahl: {photoList.length}</div>
            <div>Größe: {totalSizeHint}</div>
            {fotoWmNeeded && (
              <div>
                Wasserzeichen: {watermarkIndices.size} / {photoList.length}
              </div>
            )}
          </dl>
          {explicitlySelected && selected.size > 0 && (
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
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
        onError={(msg) => showError(msg, "Datei")}
        onCopied={() => showSuccess("Pfad in die Zwischenablage kopiert.", "Pfad")}
        actionsDisabled={disabled || scanning}
        onScanQr={(path) => void handleQrScan(path)}
        onRemove={(path) => {
          const idx = photoList.findIndex((p) => p.path === path);
          if (idx >= 0) removePhotos([idx]);
        }}
      />
    </div>
  );
}
