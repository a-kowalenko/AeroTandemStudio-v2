import { useCallback, useState } from "react";
import {
  discardPhotoEditUndoForPath,
  getFileSizes,
  cropPhoto,
  rotatePhoto,
  undoPhotoEditForPath,
} from "../lib/tauri";
import { usePhotoStore } from "../store/photoStore";
import { useUiStore } from "../store/uiStore";

type ApplyOptions = {
  onBusyChange?: (busy: boolean) => void;
  onProgressReset?: () => void;
  onStatus?: (message: string) => void;
};

type CropRect = { x: number; y: number; w: number; h: number };

function beginProgress(opts: ApplyOptions | undefined, message: string) {
  opts?.onBusyChange?.(true);
  opts?.onProgressReset?.();
  opts?.onStatus?.(message);
}

function endProgress(opts: ApplyOptions | undefined) {
  opts?.onBusyChange?.(false);
}

/**
 * Apply photo rotate/crop / undo on working copies.
 */
export function usePhotoEditApply() {
  const [applying, setApplying] = useState(false);
  const editMarks = usePhotoStore((s) => s.editMarks);
  const canUndo = Object.keys(editMarks).length > 0;
  const markRotated = usePhotoStore((s) => s.markRotated);
  const markCropped = usePhotoStore((s) => s.markCropped);
  const updatePhotoMeta = usePhotoStore((s) => s.updatePhotoMeta);
  const clearEditMarksFor = usePhotoStore((s) => s.clearEditMarksFor);
  const clearAllEditMarks = usePhotoStore((s) => s.clearAllEditMarks);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);

  const applyRotate = useCallback(
    async (sourcePath: string, degrees: number, opts?: ApplyOptions) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, "Foto wird gedreht…");
      try {
        const res = await rotatePhoto({
          input: sourcePath,
          degrees,
          overwrite: true,
        });
        markRotated(sourcePath);
        const sizes = await getFileSizes([sourcePath]);
        updatePhotoMeta(sourcePath, {
          width: res.width,
          height: res.height,
          sizeBytes: sizes[0]?.size_bytes,
        });
        opts?.onStatus?.("Drehen fertig");
        showSuccess(
          "Drehung übernommen. Rückgängig über „Bearbeitung rückgängig“.",
          "Bearbeiten",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Drehen fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, markRotated, updatePhotoMeta, showError, showSuccess],
  );

  const applyCrop = useCallback(
    async (sourcePath: string, rect: CropRect, opts?: ApplyOptions) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, "Foto wird zugeschnitten…");
      try {
        const res = await cropPhoto({
          input: sourcePath,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          overwrite: true,
        });
        markCropped(sourcePath);
        const sizes = await getFileSizes([sourcePath]);
        updatePhotoMeta(sourcePath, {
          width: res.width,
          height: res.height,
          sizeBytes: sizes[0]?.size_bytes,
        });
        opts?.onStatus?.("Zuschnitt fertig");
        showSuccess(
          "Zuschnitt übernommen. Rückgängig über „Bearbeitung rückgängig“.",
          "Bearbeiten",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Zuschnitt fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, markCropped, updatePhotoMeta, showError, showSuccess],
  );

  /**
   * Commit pending rotate and/or crop in the order established in the editor.
   * Undo restores the first pre-edit backup (both steps share one undo).
   */
  const applyEdits = useCallback(
    async (
      sourcePath: string,
      args: {
        degrees: number;
        crop: CropRect | null;
        order: "crop-first" | "rotate-first";
      },
      opts?: ApplyOptions,
    ) => {
      if (applying) return;
      const deg = ((Math.round(args.degrees) % 360) + 360) % 360;
      const hasRotate = deg !== 0;
      const hasCrop = args.crop != null;
      if (!hasRotate && !hasCrop) return;

      setApplying(true);
      beginProgress(opts, "Foto wird bearbeitet…");
      try {
        let width = 0;
        let height = 0;
        const doRotate = async () => {
          opts?.onStatus?.("Foto wird gedreht…");
          const res = await rotatePhoto({
            input: sourcePath,
            degrees: deg,
            overwrite: true,
          });
          width = res.width;
          height = res.height;
        };
        const doCrop = async () => {
          const rect = args.crop!;
          opts?.onStatus?.("Foto wird zugeschnitten…");
          const res = await cropPhoto({
            input: sourcePath,
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            overwrite: true,
          });
          width = res.width;
          height = res.height;
        };

        if (hasCrop && hasRotate) {
          if (args.order === "crop-first") {
            await doCrop();
            await doRotate();
          } else {
            await doRotate();
            await doCrop();
          }
          // Badge: crop wins when both applied (last mark write).
          markRotated(sourcePath);
          markCropped(sourcePath);
        } else if (hasCrop) {
          await doCrop();
          markCropped(sourcePath);
        } else {
          await doRotate();
          markRotated(sourcePath);
        }

        const sizes = await getFileSizes([sourcePath]);
        updatePhotoMeta(sourcePath, {
          width,
          height,
          sizeBytes: sizes[0]?.size_bytes,
        });
        opts?.onStatus?.("Bearbeitung fertig");
        const parts = [
          hasCrop ? "Zuschnitt" : null,
          hasRotate ? "Drehung" : null,
        ].filter(Boolean);
        showSuccess(
          `${parts.join(" und ")} übernommen. Rückgängig über „Bearbeitung rückgängig“.`,
          "Bearbeiten",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Bearbeitung fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [
      applying,
      markCropped,
      markRotated,
      updatePhotoMeta,
      showError,
      showSuccess,
    ],
  );

  /** Rotate several paths sequentially (selection batch). */
  const applyRotateMany = useCallback(
    async (paths: string[], degrees: number, opts?: ApplyOptions) => {
      if (applying || paths.length === 0) return;
      setApplying(true);
      beginProgress(opts, `Drehe ${paths.length} Foto(s)…`);
      let ok = 0;
      try {
        for (let i = 0; i < paths.length; i++) {
          const path = paths[i]!;
          opts?.onStatus?.(`Drehe Foto ${i + 1}/${paths.length}…`);
          const res = await rotatePhoto({
            input: path,
            degrees,
            overwrite: true,
          });
          markRotated(path);
          const sizes = await getFileSizes([path]);
          updatePhotoMeta(path, {
            width: res.width,
            height: res.height,
            sizeBytes: sizes[0]?.size_bytes,
          });
          ok += 1;
        }
        opts?.onStatus?.("Drehen fertig");
        showSuccess(
          `${ok} Foto(s) gedreht.`,
          "Bearbeiten",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(
          ok > 0
            ? `${ok} Foto(s) gedreht, dann Fehler: ${String(e)}`
            : String(e),
          "Drehen fehlgeschlagen",
        );
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, markRotated, updatePhotoMeta, showError, showSuccess],
  );

  const undoForPath = useCallback(
    async (path: string, opts?: ApplyOptions) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, "Foto-Bearbeitung wird rückgängig gemacht…");
      try {
        const res = await undoPhotoEditForPath(path);
        clearEditMarksFor([res.restore_path]);
        const sizes = await getFileSizes([res.restore_path]);
        updatePhotoMeta(res.restore_path, {
          sizeBytes: sizes[0]?.size_bytes,
          width: undefined,
          height: undefined,
        });
        opts?.onStatus?.("Rückgängig fertig");
        showSuccess("Foto-Bearbeitung rückgängig gemacht.", "Rückgängig", {
          autoCloseSecs: 5,
        });
      } catch (e) {
        showError(String(e), "Rückgängig fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, clearEditMarksFor, updatePhotoMeta, showError, showSuccess],
  );

  const discardForPath = useCallback((path: string) => {
    clearEditMarksFor([path]);
    void discardPhotoEditUndoForPath(path);
  }, [clearEditMarksFor]);

  const clearUndoState = useCallback(() => {
    clearAllEditMarks();
  }, [clearAllEditMarks]);

  return {
    applying,
    canUndo,
    applyRotate,
    applyCrop,
    applyEdits,
    applyRotateMany,
    undoForPath,
    discardForPath,
    clearUndoState,
  };
}
