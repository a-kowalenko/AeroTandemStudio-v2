import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/utils";

export type NormCropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CropAspectPreset =
  | "free"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

export const CROP_ASPECT_PRESETS: {
  id: CropAspectPreset;
  label: string;
}[] = [
  { id: "free", label: "Frei" },
  { id: "1:1", label: "1:1" },
  { id: "4:3", label: "4:3" },
  { id: "3:4", label: "3:4" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
];

export const FULL_CROP: NormCropRect = { x: 0, y: 0, w: 1, h: 1 };

const MIN_EDGE = 0.05;
const HANDLE_PX = 14;

type Handle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "nw"
  | "ne"
  | "sw"
  | "se";

type Props = {
  value: NormCropRect;
  onChange: (next: NormCropRect) => void;
  /**
   * Required `w/h` in normalized space when aspect-locked.
   * = (presetW/presetH) * (imgH/imgW). Null/undefined = free.
   */
  aspectNorm?: number | null;
  /** Pointer down on a handle / move surface (for iOS-style settle). */
  onGestureStart?: () => void;
  /** Pointer up / cancel after a drag. */
  onGestureEnd?: () => void;
  className?: string;
};

function clampRect(r: NormCropRect): NormCropRect {
  let { x, y, w, h } = r;
  w = Math.max(MIN_EDGE, Math.min(1, w));
  h = Math.max(MIN_EDGE, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

export function isCropDirty(rect: NormCropRect): boolean {
  return (
    rect.x > 0.002 ||
    rect.y > 0.002 ||
    rect.w < 0.998 ||
    rect.h < 0.998
  );
}

/** Pixel aspect `presetW/presetH` → normalized w/h for this image. */
export function aspectNormFromPreset(
  preset: CropAspectPreset,
  imgW: number,
  imgH: number,
): number | null {
  if (preset === "free" || imgW <= 0 || imgH <= 0) return null;
  const [aw, ah] = preset.split(":").map(Number) as [number, number];
  return (aw / ah) * (imgH / imgW);
}

/** Largest centered rect for a preset inside the image. */
export function rectForAspectPreset(
  preset: CropAspectPreset,
  imgW: number,
  imgH: number,
): NormCropRect {
  const aspectNorm = aspectNormFromPreset(preset, imgW, imgH);
  if (aspectNorm == null) return FULL_CROP;
  let w: number;
  let h: number;
  if (aspectNorm >= 1) {
    w = 1;
    h = 1 / aspectNorm;
  } else {
    h = 1;
    w = aspectNorm;
  }
  if (h > 1) {
    h = 1;
    w = aspectNorm;
  }
  if (w > 1) {
    w = 1;
    h = 1 / aspectNorm;
  }
  w = Math.max(MIN_EDGE, Math.min(1, w));
  h = Math.max(MIN_EDGE, Math.min(1, h));
  return clampRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

function applyAspectFromHandle(
  next: NormCropRect,
  handle: Handle,
  aspectNorm: number,
  origin: NormCropRect,
): NormCropRect {
  const right = origin.x + origin.w;
  const bottom = origin.y + origin.h;

  let { x, y, w, h } = next;

  const setFromWidth = (width: number, anchor: "w" | "e") => {
    w = Math.max(MIN_EDGE, width);
    h = w / aspectNorm;
    if (h < MIN_EDGE) {
      h = MIN_EDGE;
      w = h * aspectNorm;
    }
    if (anchor === "w") {
      x = right - w;
    }
  };

  switch (handle) {
    case "e":
    case "w":
      setFromWidth(w, handle === "w" ? "w" : "e");
      y = origin.y + (origin.h - h) / 2;
      if (handle === "w") x = right - w;
      else x = origin.x;
      break;
    case "n":
    case "s":
      h = Math.max(MIN_EDGE, h);
      w = h * aspectNorm;
      if (w < MIN_EDGE) {
        w = MIN_EDGE;
        h = w / aspectNorm;
      }
      x = origin.x + (origin.w - w) / 2;
      if (handle === "n") y = bottom - h;
      else y = origin.y;
      break;
    case "se":
      setFromWidth(w, "e");
      x = origin.x;
      y = origin.y;
      break;
    case "sw":
      setFromWidth(w, "w");
      y = origin.y;
      break;
    case "ne":
      setFromWidth(w, "e");
      y = bottom - h;
      break;
    case "nw":
      setFromWidth(w, "w");
      y = bottom - h;
      break;
    default:
      break;
  }

  if (w > 1) {
    w = 1;
    h = w / aspectNorm;
  }
  if (h > 1) {
    h = 1;
    w = h * aspectNorm;
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  return clampRect({ x, y, w, h });
}

/**
 * Interactive crop overlay (normalized 0–1) over a frame sized exactly to the image.
 * Handles sit on edges/corners (half outside); parent must allow overflow + padding.
 */
export function PhotoCropOverlay({
  value,
  onChange,
  aspectNorm = null,
  onGestureStart,
  onGestureEnd,
  className,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    origin: NormCropRect;
  } | null>(null);

  const onPointerDown = useCallback(
    (handle: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        origin: value,
      };
      onGestureStart?.();
    },
    [value, onGestureStart],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const root = rootRef.current;
      if (!drag || !root) return;
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      const o = drag.origin;
      let next = { ...o };

      switch (drag.handle) {
        case "move":
          next.x = o.x + dx;
          next.y = o.y + dy;
          break;
        case "n":
          next.y = o.y + dy;
          next.h = o.h - dy;
          break;
        case "s":
          next.h = o.h + dy;
          break;
        case "w":
          next.x = o.x + dx;
          next.w = o.w - dx;
          break;
        case "e":
          next.w = o.w + dx;
          break;
        case "nw":
          next.x = o.x + dx;
          next.y = o.y + dy;
          next.w = o.w - dx;
          next.h = o.h - dy;
          break;
        case "ne":
          next.y = o.y + dy;
          next.w = o.w + dx;
          next.h = o.h - dy;
          break;
        case "sw":
          next.x = o.x + dx;
          next.w = o.w - dx;
          next.h = o.h + dy;
          break;
        case "se":
          next.w = o.w + dx;
          next.h = o.h + dy;
          break;
      }

      if (aspectNorm != null && aspectNorm > 0 && drag.handle !== "move") {
        next = applyAspectFromHandle(next, drag.handle, aspectNorm, o);
      } else {
        if (next.w < MIN_EDGE) {
          if (drag.handle.includes("w")) {
            next.x = o.x + o.w - MIN_EDGE;
          }
          next.w = MIN_EDGE;
        }
        if (next.h < MIN_EDGE) {
          if (drag.handle.includes("n")) {
            next.y = o.y + o.h - MIN_EDGE;
          }
          next.h = MIN_EDGE;
        }
        next = clampRect(next);
      }

      onChange(next);
    },
    [onChange, aspectNorm],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      onGestureEnd?.();
    },
    [onGestureEnd],
  );

  const left = `${value.x * 100}%`;
  const top = `${value.y * 100}%`;
  const width = `${value.w * 100}%`;
  const height = `${value.h * 100}%`;

  return (
    <div
      ref={rootRef}
      className={cn("absolute inset-0 touch-none select-none", className)}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Dim outside crop */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 bg-black/55"
        style={{ height: top }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55"
        style={{ height: `${(1 - value.y - value.h) * 100}%` }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ top, height, left: 0, width: left }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{
          top,
          height,
          left: `${(value.x + value.w) * 100}%`,
          right: 0,
        }}
      />

      {/* Crop frame */}
      <div
        className="absolute z-10 cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left, top, width, height }}
        onPointerDown={onPointerDown("move")}
      >
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/35" />
          <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/35" />
          <div className="absolute left-0 right-0 top-1/3 h-px bg-white/35" />
          <div className="absolute left-0 right-0 top-2/3 h-px bg-white/35" />
        </div>
      </div>

      {/* Edge handles — centered on border (half outside) */}
      <div
        className="absolute z-20 cursor-ns-resize touch-none"
        style={{
          left,
          width,
          top: `calc(${top} - ${HANDLE_PX / 2}px)`,
          height: HANDLE_PX,
        }}
        onPointerDown={onPointerDown("n")}
      />
      <div
        className="absolute z-20 cursor-ns-resize touch-none"
        style={{
          left,
          width,
          top: `calc(${(value.y + value.h) * 100}% - ${HANDLE_PX / 2}px)`,
          height: HANDLE_PX,
        }}
        onPointerDown={onPointerDown("s")}
      />
      <div
        className="absolute z-20 cursor-ew-resize touch-none"
        style={{
          top,
          height,
          left: `calc(${left} - ${HANDLE_PX / 2}px)`,
          width: HANDLE_PX,
        }}
        onPointerDown={onPointerDown("w")}
      />
      <div
        className="absolute z-20 cursor-ew-resize touch-none"
        style={{
          top,
          height,
          left: `calc(${(value.x + value.w) * 100}% - ${HANDLE_PX / 2}px)`,
          width: HANDLE_PX,
        }}
        onPointerDown={onPointerDown("e")}
      />

      {/* Corner knobs — centered on corners (half outside) */}
      {(
        [
          ["nw", value.x, value.y, "cursor-nwse-resize"],
          ["ne", value.x + value.w, value.y, "cursor-nesw-resize"],
          ["sw", value.x, value.y + value.h, "cursor-nesw-resize"],
          ["se", value.x + value.w, value.y + value.h, "cursor-nwse-resize"],
        ] as const
      ).map(([id, hx, hy, cursor]) => (
        <button
          key={id}
          type="button"
          aria-label={`Crop ${id}`}
          className={cn(
            "absolute z-30 rounded-full bg-white shadow-md touch-none",
            cursor,
          )}
          style={{
            width: HANDLE_PX,
            height: HANDLE_PX,
            left: `calc(${hx * 100}% - ${HANDLE_PX / 2}px)`,
            top: `calc(${hy * 100}% - ${HANDLE_PX / 2}px)`,
          }}
          onPointerDown={onPointerDown(id)}
        />
      ))}
    </div>
  );
}
