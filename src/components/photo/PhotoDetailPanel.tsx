import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Pencil,
  QrCode,
  RotateCcw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { CREATE_READY_IDS } from "../../lib/createReadyHints";
import { PHOTO_THUMB_PRIORITY } from "../../lib/photoThumbnailQueue";
import { cn } from "../../lib/utils";
import type { PhotoItem } from "../../store/photoStore";
import {
  photoFileSrcFallback,
  usePhotoThumbnailSrc,
} from "./usePhotoThumbnailSrc";

function formatBytes(n: number | undefined): string {
  if (n == null || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatResolution(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  return `${width}×${height}`;
}

type Props = {
  current: PhotoItem | null;
  currentIndex: number;
  photoCount: number;
  totalSizeHint: string;
  fotoWmNeeded: boolean;
  watermarkCount: number;
  isCurrentWm: boolean;
  editMark: "crop" | "rotate" | null;
  revision: number;
  qrScanBusy: boolean;
  scanning: boolean;
  disabled?: boolean;
  showMiniPreview: boolean;
  effectiveSelectionSize: number;
  explicitlySelected: boolean;
  selectedIndices: number[];
  photoPathsByIndex: (indices: number[]) => string[];
  onToggleWatermark: () => void;
  onEditPhoto?: (path: string) => void;
  onUndoPhotoEdit?: (path: string) => void;
  onBatchRotate?: (paths: string[], degrees: number) => void;
  onScanQr: () => void;
  onRemove: () => void;
  onClearSelection: () => void;
};

export const PhotoDetailPanel = forwardRef<HTMLElement, Props>(
  function PhotoDetailPanel(
    {
      current,
      currentIndex,
      photoCount,
      totalSizeHint,
      fotoWmNeeded,
      watermarkCount,
      isCurrentWm,
      editMark,
      revision,
      qrScanBusy,
      scanning,
      disabled,
      showMiniPreview,
      effectiveSelectionSize,
      explicitlySelected,
      selectedIndices,
      photoPathsByIndex,
      onToggleWatermark,
      onEditPhoto,
      onUndoPhotoEdit,
      onBatchRotate,
      onScanQr,
      onRemove,
      onClearSelection,
    },
    ref,
  ) {
  const { t } = useTranslation();

  const previewSrc = usePhotoThumbnailSrc(
    current?.path ?? null,
    "preview",
    revision,
    PHOTO_THUMB_PRIORITY.stageUpgrade,
    { enabled: Boolean(current) && showMiniPreview && !qrScanBusy },
  );
  const miniSrc = current
    ? (previewSrc ?? photoFileSrcFallback(current.path, revision))
    : null;

  return (
    <aside
      ref={ref}
      className="flex w-full flex-col gap-3 lg:min-w-[17.5rem] lg:w-[17.5rem] xl:w-80"
    >
      <div className="flex flex-col rounded-lg border border-border/60 bg-card-elevated/80 p-3">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("photo.preview.detailTitle")}
        </p>

        {showMiniPreview && current && miniSrc && (
          <div className="relative mb-3 aspect-video overflow-hidden rounded-md bg-[var(--ats-preview-stage)] ring-1 ring-border/60">
            <img
              src={miniSrc}
              alt={current.filename}
              className="h-full w-full object-contain"
            />
          </div>
        )}
        {current ? (
          <dl className="space-y-1 text-xs text-muted">
            <div>
              <dt className="inline text-foreground">
                {t("photo.preview.meta.file")}:{" "}
              </dt>
              <dd className="inline break-all">{current.filename}</dd>
            </div>
            <div>
              {t("photo.preview.meta.size")}: {formatBytes(current.sizeBytes)}
            </div>
            <div>
              {t("photo.preview.meta.resolution")}:{" "}
              {formatResolution(current.width, current.height)}
            </div>
            <div>
              {t("photo.preview.meta.position")}: {currentIndex + 1} /{" "}
              {photoCount}
            </div>
            {(current.camera_make || current.camera_model) && (
              <div>
                {t("photo.preview.meta.camera")}:{" "}
                {[current.camera_make, current.camera_model]
                  .filter(Boolean)
                  .join(" ")}
              </div>
            )}
          </dl>
        ) : (
          <p className="text-xs text-muted">{t("photo.preview.detailEmpty")}</p>
        )}

        {current && fotoWmNeeded && (
          <button
            type="button"
            disabled={disabled}
            aria-pressed={isCurrentWm}
            aria-label={t("photo.preview.wmToggleAria")}
            onClick={onToggleWatermark}
            className={cn(
              "mt-3 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              isCurrentWm
                ? "border-amber-500/50 bg-amber-500/15 ring-1 ring-inset ring-amber-500/30"
                : "border-border/60 bg-background/40 hover:border-border hover:bg-background/70",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-foreground">
                {t("photo.preview.wmPreviewLabel")}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                {t("photo.preview.wmPreviewHint")}
              </span>
            </span>
            <Checkbox
              checked={isCurrentWm}
              tabIndex={-1}
              aria-hidden
              className={cn(
                "pointer-events-none h-6 w-6 [&_svg]:h-4 [&_svg]:w-4",
                isCurrentWm &&
                  "border-amber-500 data-[state=checked]:border-amber-500 data-[state=checked]:bg-amber-500",
              )}
            />
          </button>
        )}

        {current && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || !onEditPhoto}
              onClick={() => onEditPhoto?.(current.path)}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("common.actions.edit")}
            </Button>
            {editMark && onUndoPhotoEdit && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onUndoPhotoEdit(current.path)}
                title={t("photo.preview.undoThisEditTitle")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("photo.preview.undoEdit")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || scanning}
              onClick={onScanQr}
            >
              <QrCode className="h-3.5 w-3.5" />
              {t("media.list.scanQr")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={disabled || effectiveSelectionSize === 0}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {effectiveSelectionSize > 1
                ? t("photo.preview.removeCount", {
                    count: effectiveSelectionSize,
                  })
                : t("common.actions.remove")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col rounded-lg border border-border/60 bg-card-elevated/80 p-3">
        <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("photo.preview.sessionTitle")}
        </p>
        <dl className="space-y-0.5 text-xs text-muted">
          <div>
            {t("photo.preview.meta.count")}: {photoCount}
          </div>
          <div>
            {t("photo.preview.meta.size")}: {totalSizeHint}
          </div>
          {fotoWmNeeded && (
            <div
              id={CREATE_READY_IDS.watermark}
              tabIndex={-1}
              className="outline-none"
            >
              {t("photo.preview.meta.watermark")}: {watermarkCount} /{" "}
              {photoCount}
            </div>
          )}
        </dl>

        {explicitlySelected && selectedIndices.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3">
            <p className="w-full text-[11px] font-medium text-foreground">
              {t("photo.preview.batchSelected", {
                count: selectedIndices.length,
              })}
            </p>
            {onBatchRotate && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onBatchRotate(photoPathsByIndex(selectedIndices), -90)
                  }
                  title={t("photo.preview.batchRotateCcwTitle")}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("photo.preview.batchRotate90")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onBatchRotate(photoPathsByIndex(selectedIndices), 90)
                  }
                  title={t("photo.preview.batchRotateCwTitle")}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  {t("photo.preview.batchRotate90")}
                </Button>
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onClearSelection}
            >
              {t("photo.preview.clearSelection")}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
  },
);
