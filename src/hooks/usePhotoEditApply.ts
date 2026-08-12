import { useCallback, useState } from "react";
import {
  discardPhotoEditUndoForPath,
  getFileSizes,
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

function beginProgress(opts: ApplyOptions | undefined, message: string) {
  opts?.onBusyChange?.(true);
  opts?.onProgressReset?.();
  opts?.onStatus?.(message);
}

function endProgress(opts: ApplyOptions | undefined) {
  opts?.onBusyChange?.(false);
}

/**
 * Apply photo rotate / undo on working copies.
 */
export function usePhotoEditApply() {
  const [applying, setApplying] = useState(false);
  const editMarks = usePhotoStore((s) => s.editMarks);
  const canUndo = Object.keys(editMarks).length > 0;
  const markRotated = usePhotoStore((s) => s.markRotated);
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
    applyRotateMany,
    undoForPath,
    discardForPath,
    clearUndoState,
  };
}
