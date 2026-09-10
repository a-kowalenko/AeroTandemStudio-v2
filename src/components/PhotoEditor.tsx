import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Crop, RotateCw } from "lucide-react";
import { MediaEditShell, type MediaEditModeOption } from "./MediaEditShell";
import { MediaEditControlsRow, MediaEditRotateBar, MediaEditToolReset } from "./MediaEditRotateBar";
import {
  FULL_CROP,
  PhotoCropOverlay,
  CROP_ASPECT_PRESETS,
  aspectNormFromPreset,
  isCropDirty,
  rectForAspectPreset,
  type CropAspectPreset,
  type NormCropRect,
} from "./PhotoCropOverlay";
import { useUiStore } from "../store/uiStore";
import { usePhotoStore } from "../store/photoStore";
import {
  hasNetPreviewRotate,
  isFullTurnPreviewRotate,
  isQuarterTurnSwap,
  normalizePreviewRotateDeg,
  previewRotateMediaStyleInFrame,
} from "../lib/mediaPreviewRotate";
import {
  mapCropThroughRotation,
  orientedNaturalSize,
  previewContentSize,
  resolvePhotoEditOrder,
  type PhotoEditOrder,
} from "../lib/photoEditCompose";
import { cn } from "../lib/utils";

export type { PhotoEditOrder } from "../lib/photoEditCompose";
export { mapCropThroughRotation } from "../lib/photoEditCompose";

export type PhotoEditorResult =
  | { action: "cancel" }
  | {
      action: "apply_edits";
      degrees: number;
      crop: NormCropRect | null;
      order: PhotoEditOrder;
    };

type PhotoEditMode = "crop" | "rotate";

type PhotoEditorProps = {
  open: boolean;
  photoPath: string | null;
  onClose: () => void;
  onComplete: (result: PhotoEditorResult) => void;
};

/** Idle after crop drag before viewport settles (iOS-style, pre-commit). */
const CROP_SETTLE_MS = 1400;
/** Frame / inner / shadow transition while settling or unsettling. */
const CROP_LAYOUT_MS = 350;
const CROP_LAYOUT_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const CROP_LAYOUT_TRANSITION = `width ${CROP_LAYOUT_MS}ms ${CROP_LAYOUT_EASE}, height ${CROP_LAYOUT_MS}ms ${CROP_LAYOUT_EASE}, left ${CROP_LAYOUT_MS}ms ${CROP_LAYOUT_EASE}, top ${CROP_LAYOUT_MS}ms ${CROP_LAYOUT_EASE}`;

const PHOTO_MODE_DEFS: { id: PhotoEditMode; labelKey: string; icon: React.ReactNode }[] = [
  {
    id: "crop",
    labelKey: "photo.edit.mode.crop",
    icon: <Crop className="h-4 w-4" strokeWidth={2} />,
  },
  {
    id: "rotate",
    labelKey: "photo.edit.mode.rotate",
    icon: <RotateCw className="h-4 w-4" strokeWidth={2} />,
  },
];

function containSize(
  stageW: number,
  stageH: number,
  imgW: number,
  imgH: number,
): { w: number; h: number } {
  if (stageW <= 0 || stageH <= 0 || imgW <= 0 || imgH <= 0) {
    return { w: 0, h: 0 };
  }
  const imgAspect = imgW / imgH;
  const stageAspect = stageW / stageH;
  if (imgAspect > stageAspect) {
    return { w: stageW, h: stageW / imgAspect };
  }
  return { w: stageH * imgAspect, h: stageH };
}

/**
 * Soft-bake photo editor: crop + rotate share one visual draft across modes.
 * Working copy is written only on Übernehmen (`apply_edits`).
 *
 * When rotation is pending, crop lives in oriented (rotate-first) space so
 * Zuschneiden shows the same preview as Drehen.
 */
export function PhotoEditor({
  open,
  photoPath,
  onClose,
  onComplete,
}: PhotoEditorProps) {
  const { t } = useTranslation();
  const photoModes = useMemo<MediaEditModeOption<PhotoEditMode>[]>(
    () =>
      PHOTO_MODE_DEFS.map(({ id, labelKey, icon }) => ({
        id,
        label: t(labelKey),
        icon,
      })),
    [t],
  );
  const committedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const editOrderRef = useRef<PhotoEditOrder | null>(null);
  const cropRectRef = useRef<NormCropRect>(FULL_CROP);
  const gesturingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const showWarning = useUiStore((s) => s.showWarning);
  const getMediaRevision = usePhotoStore((s) => s.getMediaRevision);

  const [mode, setMode] = useState<PhotoEditMode>("crop");
  const [pendingRotateDeg, setPendingRotateDeg] = useState(0);
  const [cropRect, setCropRect] = useState<NormCropRect>(FULL_CROP);
  const [aspectPreset, setAspectPreset] = useState<CropAspectPreset>("free");
  const [editOrder, setEditOrder] = useState<PhotoEditOrder | null>(null);
  const [cropSettled, setCropSettled] = useState(false);
  const [gesturing, setGesturing] = useState(false);
  /** Disable CSS rotate transition when snapping ±360 → 0. */
  const [rotateTransition, setRotateTransition] = useState(true);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  editOrderRef.current = editOrder;
  cropRectRef.current = cropRect;

  function clearSettleTimer() {
    if (settleTimerRef.current != null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function scheduleSettle() {
    clearSettleTimer();
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (gesturingRef.current) return;
      if (isCropDirty(cropRectRef.current)) {
        setCropSettled(true);
      }
    }, CROP_SETTLE_MS);
  }

  function unsettleCrop() {
    clearSettleTimer();
    setCropSettled(false);
  }

  function resetSession() {
    clearSettleTimer();
    gesturingRef.current = false;
    setGesturing(false);
    setRotateTransition(true);
    setPendingRotateDeg(0);
    setCropRect(FULL_CROP);
    setAspectPreset("free");
    setEditOrder(null);
    setCropSettled(false);
    setNaturalSize(null);
    setStageSize({ w: 0, h: 0 });
    setMode("crop");
  }

  useEffect(() => {
    if (!open) {
      resetSession();
      return;
    }
    committedRef.current = false;
    resetSession();
    return () => clearSettleTimer();
  }, [open, photoPath]);

  const rotatePending = hasNetPreviewRotate(pendingRotateDeg);
  const cropPending = isCropDirty(cropRect);
  const order = resolvePhotoEditOrder({
    editOrder,
    cropPending,
    rotatePending,
  });

  // Soft-bake: pending rotation is always part of the visible draft.
  const showRotatePreview = rotatePending || mode === "rotate";

  // Settled crop viewport after idle, or immediately in rotate mode.
  const showCroppedViewport =
    cropPending && (cropSettled || mode === "rotate");

  const cropMode = mode === "crop";

  // After 270°→360° (or −270→−360), keep rotate(±360) for the short-path
  // animation, then snap to 0 without transitioning so the next ±90° is short.
  useEffect(() => {
    if (!isFullTurnPreviewRotate(pendingRotateDeg)) return;
    const ms = rotateTransition ? 220 : 0;
    const id = window.setTimeout(() => {
      setRotateTransition(false);
      setPendingRotateDeg(0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setRotateTransition(true));
      });
    }, ms);
    return () => window.clearTimeout(id);
  }, [pendingRotateDeg, rotateTransition]);

  const content = naturalSize
    ? previewContentSize(
        naturalSize,
        cropRect,
        order,
        pendingRotateDeg,
        showCroppedViewport,
        showRotatePreview,
      )
    : { w: 0, h: 0 };

  // Derive frame in-render so settle/unsettle never flashes a stale size.
  const framePx =
    content.w > 0 && content.h > 0 && stageSize.w > 0 && stageSize.h > 0
      ? (() => {
          const next = containSize(
            stageSize.w,
            stageSize.h,
            content.w,
            content.h,
          );
          return next.w > 0 && next.h > 0 ? next : null;
        })()
      : null;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !open) {
      return;
    }
    const update = () => {
      setStageSize({
        w: stage.clientWidth,
        h: stage.clientHeight,
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [open, naturalSize]);

  function ensureOrder(next: PhotoEditOrder) {
    setEditOrder((prev) => prev ?? next);
  }

  function updateCrop(next: NormCropRect) {
    setCropRect(next);
    if (isCropDirty(next)) {
      // Soft-bake: with pending rotation, crop lives in oriented space.
      ensureOrder(rotatePending ? "rotate-first" : "crop-first");
      if (!gesturingRef.current) {
        unsettleCrop();
        scheduleSettle();
      }
    } else {
      clearSettleTimer();
      setCropSettled(false);
      if (!rotatePending) {
        setEditOrder(null);
      } else {
        setEditOrder("rotate-first");
      }
    }
  }

  function beginCropGesture() {
    gesturingRef.current = true;
    setGesturing(true);
    unsettleCrop();
  }

  function endCropGesture() {
    gesturingRef.current = false;
    setGesturing(false);
    if (isCropDirty(cropRectRef.current)) {
      scheduleSettle();
    }
  }

  function handleModeChange(next: PhotoEditMode) {
    setMode(next);
    if (next === "rotate" && isCropDirty(cropRectRef.current)) {
      clearSettleTimer();
      setCropSettled(true);
    }
  }

  function bumpRotate(delta: number) {
    const stepTurns = Math.round(delta / 90);
    setPendingRotateDeg((d) => d + delta);
    const rect = cropRectRef.current;
    // Soft-bake: always keep crop in the visible oriented space.
    if (isCropDirty(rect)) {
      setCropRect(mapCropThroughRotation(rect, stepTurns * 90));
      setEditOrder("rotate-first");
      setCropSettled(true);
    } else {
      ensureOrder("rotate-first");
    }
  }

  function resetRotate() {
    const ord = editOrderRef.current;
    const rect = cropRectRef.current;
    const deg = normalizePreviewRotateDeg(pendingRotateDeg);
    let nextRect = rect;
    if (
      (ord === "rotate-first" || rotatePending) &&
      isCropDirty(rect) &&
      deg !== 0
    ) {
      nextRect = mapCropThroughRotation(rect, (360 - deg) % 360);
      setCropRect(nextRect);
    }
    setRotateTransition(false);
    setPendingRotateDeg(0);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setRotateTransition(true));
    });
    setEditOrder(isCropDirty(nextRect) ? "crop-first" : null);
    if (isCropDirty(nextRect)) {
      setCropSettled(true);
    }
  }

  function finish(result: PhotoEditorResult) {
    if (committedRef.current) return;
    committedRef.current = true;
    onComplete(result);
    onClose();
  }

  function cancel() {
    if (committedRef.current) {
      onClose();
      return;
    }
    committedRef.current = true;
    onComplete({ action: "cancel" });
    onClose();
  }

  function handleDone() {
    const deg = normalizePreviewRotateDeg(pendingRotateDeg);
    const crop = cropPending ? cropRect : null;
    if (deg === 0 && !crop) {
      showWarning(t("photo.editor.warning.noEdit"), t("video.cutter.warning.noChangeTitle"));
      return;
    }
    const commitOrder: PhotoEditOrder =
      order ?? (crop ? "crop-first" : "rotate-first");
    finish({
      action: "apply_edits",
      degrees: deg,
      crop,
      order: commitOrder,
    });
  }

  const rev = photoPath ? getMediaRevision(photoPath) : 0;
  const base = photoPath ? convertFileSrc(photoPath) : null;
  const src =
    open && base
      ? `${base}${base.includes("?") ? "&" : "?"}r=${rev}`
      : null;

  const doneEnabled = cropPending || rotatePending;

  const displayNatural = naturalSize
    ? orientedNaturalSize(naturalSize, pendingRotateDeg, showRotatePreview)
    : null;

  const aspectNorm =
    displayNatural && aspectPreset !== "free"
      ? aspectNormFromPreset(aspectPreset, displayNatural.w, displayNatural.h)
      : null;

  function applyAspectPreset(preset: CropAspectPreset) {
    setAspectPreset(preset);
    if (!displayNatural) {
      if (preset === "free") updateCrop(FULL_CROP);
      return;
    }
    updateCrop(rectForAspectPreset(preset, displayNatural.w, displayNatural.h));
  }

  const controls =
    mode === "crop" ? (
      <MediaEditControlsRow
        reset={
          <MediaEditToolReset
            label={t("photo.edit.resetCrop")}
            disabled={!cropPending && aspectPreset === "free"}
            onClick={() => {
              setAspectPreset("free");
              updateCrop(FULL_CROP);
            }}
          />
        }
      >
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1">
          {CROP_ASPECT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyAspectPreset(p.id)}
              className={cn(
                "rounded-md px-2 py-1 text-[12px] font-medium tabular-nums transition",
                aspectPreset === p.id
                  ? "bg-primary-soft text-foreground"
                  : "text-muted hover:bg-black/5 hover:text-foreground dark:hover:bg-white/8",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </MediaEditControlsRow>
    ) : (
      <MediaEditRotateBar
        degrees={pendingRotateDeg}
        onRotateCw={() => bumpRotate(90)}
        onRotateCcw={() => bumpRotate(-90)}
        onReset={resetRotate}
      />
    );

  // Rotate mode always uses the framed rotate layout (incl. 0°) so ±90°
  // transitions take the short path instead of remounting layout.
  const showFullWithRotate = mode === "rotate" && !showCroppedViewport;

  const transformTransition = rotateTransition
    ? "transform 200ms ease"
    : "none";

  const settledCrop = cropMode && showCroppedViewport;
  const useOrientedCropCanvas = cropMode && showRotatePreview;

  /** Inner layer: full oriented canvas; settles by zooming crop to the frame. */
  const innerStyle = settledCrop
    ? {
        width: `${100 / cropRect.w}%`,
        height: `${100 / cropRect.h}%`,
        left: `${(-cropRect.x / cropRect.w) * 100}%`,
        top: `${(-cropRect.y / cropRect.h) * 100}%`,
        transition: CROP_LAYOUT_TRANSITION,
      }
    : {
        width: "100%",
        height: "100%",
        left: "0%",
        top: "0%",
        transition: CROP_LAYOUT_TRANSITION,
      };

  function onImgLoad(e: SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalSize({
        w: img.naturalWidth,
        h: img.naturalHeight,
      });
    }
  }

  function renderOrientedCropStage() {
    if (!framePx || !src) return null;
    // Inner box pixel size = oriented full canvas (unsettled: = frame; settled: larger).
    const innerW = settledCrop ? framePx.w / cropRect.w : framePx.w;
    const innerH = settledCrop ? framePx.h / cropRect.h : framePx.h;
    const mediaStyle = previewRotateMediaStyleInFrame(
      pendingRotateDeg,
      innerW,
      innerH,
    );
    mediaStyle.transition = transformTransition;

    return (
      <>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute" style={innerStyle}>
            <img
              src={src}
              alt={t("common.labels.photo")}
              className="block"
              draggable={false}
              style={mediaStyle}
              onLoad={onImgLoad}
            />
          </div>
        </div>
        <div className="absolute" style={innerStyle}>
          <PhotoCropOverlay
            value={cropRect}
            onChange={updateCrop}
            aspectNorm={aspectNorm}
            onGestureStart={beginCropGesture}
            onGestureEnd={endCropGesture}
            shadowOpacity={settledCrop ? 0 : 0.55}
            showGrid={gesturing && !settledCrop}
            settled={settledCrop}
          />
        </div>
      </>
    );
  }

  function renderPlainCropStage() {
    if (!framePx || !src) return null;
    return (
      <>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute" style={innerStyle}>
            <img
              src={src}
              alt={t("common.labels.photo")}
              className="block h-full w-full object-fill"
              draggable={false}
              onLoad={onImgLoad}
            />
          </div>
        </div>
        <div className="absolute" style={innerStyle}>
          <PhotoCropOverlay
            value={cropRect}
            onChange={updateCrop}
            aspectNorm={aspectNorm}
            onGestureStart={beginCropGesture}
            onGestureEnd={endCropGesture}
            shadowOpacity={settledCrop ? 0 : 0.55}
            showGrid={gesturing && !settledCrop}
            settled={settledCrop}
          />
        </div>
      </>
    );
  }

  return (
    <MediaEditShell
      open={open}
      title={t("common.actions.edit")}
      description={photoPath}
      mode={mode}
      modes={photoModes}
      onModeChange={handleModeChange}
      onCancel={cancel}
      onDone={handleDone}
      doneEnabled={doneEnabled}
      controls={controls}
    >
      <div className="box-border h-full min-h-0 w-full overflow-hidden p-3.5">
        <div
          ref={stageRef}
          className="relative flex h-full min-h-0 w-full items-center justify-center"
        >
          {src ? (
            <div
              className="relative shrink-0"
              style={
                framePx
                  ? {
                      width: framePx.w,
                      height: framePx.h,
                      overflow: "visible",
                      transition: CROP_LAYOUT_TRANSITION,
                    }
                  : { width: "100%", height: "100%" }
              }
            >
              {cropMode && framePx ? (
                useOrientedCropCanvas ? (
                  renderOrientedCropStage()
                ) : (
                  renderPlainCropStage()
                )
              ) : showCroppedViewport && framePx ? (
                <div className="absolute inset-0 overflow-hidden rounded-[1px]">
                  <PendingCropPreview
                    src={src}
                    crop={cropRect}
                    degrees={showRotatePreview ? pendingRotateDeg : 0}
                    order={
                      order === "rotate-first" ? "rotate-first" : "crop-first"
                    }
                    frame={framePx}
                    rotateTransition={rotateTransition}
                    onLoadSize={(w, h) => setNaturalSize({ w, h })}
                  />
                </div>
              ) : (
                <img
                  src={src}
                  alt={t("common.labels.photo")}
                  className={cn(
                    showFullWithRotate
                      ? "block"
                      : "block h-full w-full object-fill",
                  )}
                  style={
                    showFullWithRotate
                      ? (() => {
                          const s = previewRotateMediaStyleInFrame(
                            pendingRotateDeg,
                            framePx?.w ?? 1,
                            framePx?.h ?? 1,
                          );
                          s.transition = transformTransition;
                          return s;
                        })()
                      : undefined
                  }
                  onLoad={onImgLoad}
                />
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/50">
              {t("photo.editor.noPhoto")}
            </div>
          )}
        </div>
      </div>
    </MediaEditShell>
  );
}

/** Settled crop viewport for rotate mode (optional CSS rotate). */
function PendingCropPreview({
  src,
  crop,
  degrees,
  order,
  frame,
  rotateTransition = true,
  onLoadSize,
}: {
  src: string;
  crop: NormCropRect;
  degrees: number;
  order: PhotoEditOrder;
  frame: { w: number; h: number };
  rotateTransition?: boolean;
  onLoadSize: (w: number, h: number) => void;
}) {
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      onLoadSize(img.naturalWidth, img.naturalHeight);
    }
  };

  const transformTransition = rotateTransition
    ? "transform 200ms ease"
    : "none";

  // rotate-first: crop lives in already-rotated space
  if (order === "rotate-first") {
    const fullW = frame.w / crop.w;
    const fullH = frame.h / crop.h;
    const mediaStyle = previewRotateMediaStyleInFrame(degrees, fullW, fullH);
    mediaStyle.transition = transformTransition;
    return (
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute"
          style={{
            width: fullW,
            height: fullH,
            left: -crop.x * fullW,
            top: -crop.y * fullH,
          }}
        >
          <img
            src={src}
            alt="Foto"
            className="block"
            style={mediaStyle}
            onLoad={onLoad}
          />
        </div>
      </div>
    );
  }

  // crop-first (or no rotate): crop source, then rotate the crop window
  const swapped = isQuarterTurnSwap(degrees);
  const preW = swapped ? frame.h : frame.w;
  const preH = swapped ? frame.w : frame.h;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute overflow-hidden"
        style={{
          left: "50%",
          top: "50%",
          width: preW,
          height: preH,
          transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
          transition: transformTransition,
        }}
      >
        <img
          src={src}
          alt="Foto"
          className="absolute max-w-none object-fill"
          style={{
            width: `${100 / crop.w}%`,
            height: `${100 / crop.h}%`,
            left: `${(-crop.x / crop.w) * 100}%`,
            top: `${(-crop.y / crop.h) * 100}%`,
          }}
          onLoad={onLoad}
        />
      </div>
    </div>
  );
}
