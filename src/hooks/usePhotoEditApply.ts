import { useCallback, useState } from "react";
import { tr } from "@/i18n";
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
      beginProgress(opts, tr("photo.edit.progress.rotate"));
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
        opts?.onStatus?.(tr("photo.edit.progress.rotateDone"));
        showSuccess(
          tr("photo.edit.success.rotate"),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("photo.edit.error.rotate"));
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
      beginProgress(opts, tr("photo.edit.progress.crop"));
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
        opts?.onStatus?.(tr("photo.edit.progress.cropDone"));
        showSuccess(
          tr("photo.edit.success.crop"),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("photo.edit.error.crop"));
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
      beginProgress(opts, tr("photo.edit.progress.apply"));
      try {
        let width = 0;
        let height = 0;
        const doRotate = async () => {
          opts?.onStatus?.(tr("photo.edit.progress.rotate"));
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
          opts?.onStatus?.(tr("photo.edit.progress.crop"));
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
        opts?.onStatus?.(tr("photo.edit.progress.applyDone"));
        const parts = [
          hasCrop ? "Zuschnitt" : null,
          hasRotate ? "Drehung" : null,
        ].filter(Boolean);
        showSuccess(
          tr("photo.edit.success.apply", { parts: parts.join(` ${tr("photo.edit.and")} `) }),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("photo.edit.error.apply"));
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
      beginProgress(opts, tr("photo.edit.progress.rotateMany", { count: paths.length }));
      let ok = 0;
      try {
        for (let i = 0; i < paths.length; i++) {
          const path = paths[i]!;
          opts?.onStatus?.(tr("photo.edit.progress.rotateOneOfMany", { current: i + 1, total: paths.length }));
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
        opts?.onStatus?.(tr("photo.edit.progress.rotateDone"));
        showSuccess(
          tr("photo.edit.success.rotateMany", { count: ok }),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(
          ok > 0
            ? tr("photo.edit.error.rotateManyPartial", { count: ok, error: String(e) })
            : String(e),
          tr("photo.edit.error.rotate"),
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
      beginProgress(opts, tr("photo.edit.progress.undo"));
      try {
        const res = await undoPhotoEditForPath(path);
        clearEditMarksFor([res.restore_path]);
        const sizes = await getFileSizes([res.restore_path]);
        updatePhotoMeta(res.restore_path, {
          sizeBytes: sizes[0]?.size_bytes,
          width: undefined,
          height: undefined,
        });
        opts?.onStatus?.(tr("photo.edit.progress.undoDone"));
        showSuccess(tr("photo.edit.success.undo"), tr("common.actions.undo"), {
          autoCloseSecs: 5,
        });
      } catch (e) {
        showError(String(e), tr("photo.edit.error.undo"));
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
