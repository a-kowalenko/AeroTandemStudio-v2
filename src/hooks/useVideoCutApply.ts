import { useCallback, useState } from "react";
import { tr } from "@/i18n";
import {
  cutVideo,
  probeVideo,
  splitVideo,
  undoAllVideoCuts,
  undoVideoCutForPath,
  type UndoCutResult,
} from "../lib/tauri";
import { normalizeClipRotation, useVideoStore } from "../store/videoStore";
import { useUiStore } from "../store/uiStore";

type ApplyOptions = {
  onBusyChange?: (busy: boolean) => void;
  onProgressReset?: () => void;
  /** Status line for the sticky progress panel (no full-screen overlay). */
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

async function applyUndoResult(res: UndoCutResult) {
  const replaceVideo = useVideoStore.getState().replaceVideo;
  const restoreAfterSplitUndo = useVideoStore.getState().restoreAfterSplitUndo;
  const clearCutMarksFor = useVideoStore.getState().clearCutMarksFor;
  const clearRotationsFor = useVideoStore.getState().clearRotationsFor;

  clearRotationsFor([
    res.restore_path,
    ...res.removed_paths,
    ...(res.cleared_mark_paths ?? []),
  ]);
  if (res.kind === "split" && res.removed_paths.length >= 2) {
    const meta = await probeVideo(res.restore_path);
    restoreAfterSplitUndo(res.removed_paths[0]!, res.removed_paths[1]!, meta);
  } else {
    const meta = await probeVideo(res.restore_path);
    replaceVideo(res.restore_path, meta);
  }
  clearCutMarksFor(
    res.cleared_mark_paths?.length ? res.cleared_mark_paths : [res.restore_path],
  );
}

/**
 * Apply trim/split/rotate immediately. Multi-clip undo via working-copy backups.
 * Progress uses the sticky top ProgressIndicator (same as encode) — no blur overlay.
 */
export function useVideoCutApply() {
  const [applying, setApplying] = useState(false);

  const cutMarks = useVideoStore((s) => s.cutMarks);
  const canUndo = Object.keys(cutMarks).length > 0;
  const replaceVideo = useVideoStore((s) => s.replaceVideo);
  const applySplitInList = useVideoStore((s) => s.applySplitInList);
  const markTrimmed = useVideoStore((s) => s.markTrimmed);
  const markRotated = useVideoStore((s) => s.markRotated);
  const markSplit = useVideoStore((s) => s.markSplit);
  const clearAllCutMarks = useVideoStore((s) => s.clearAllCutMarks);
  const clearCutMarksFor = useVideoStore((s) => s.clearCutMarksFor);
  const setRotation = useVideoStore((s) => s.setRotation);
  const clearRotationsFor = useVideoStore((s) => s.clearRotationsFor);
  const clearAllRotations = useVideoStore((s) => s.clearAllRotations);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);

  const clearUndoState = useCallback(() => {
    clearAllCutMarks();
  }, [clearAllCutMarks]);

  const applyTrim = useCallback(
    async (
      sourcePath: string,
      startMs: number,
      endMs: number,
      opts?: ApplyOptions,
    ) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, tr("video.edit.progress.trim"));
      try {
        await cutVideo({
          input: sourcePath,
          start: startMs / 1000,
          end: endMs / 1000,
          overwrite: true,
        });
        const meta = await probeVideo(sourcePath);
        replaceVideo(sourcePath, meta);
        markTrimmed(sourcePath);
        opts?.onStatus?.(tr("video.edit.progress.trimDone"));
        showSuccess(
          tr("video.edit.success.trim"),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("video.edit.error.trim"));
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, replaceVideo, markTrimmed, showError, showSuccess],
  );

  const applySplit = useCallback(
    async (sourcePath: string, splitMs: number, opts?: ApplyOptions) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, tr("video.edit.progress.split"));
      try {
        const res = await splitVideo({
          input: sourcePath,
          splitSecs: splitMs / 1000,
          overwrite: true,
        });
        const [m1, m2] = await Promise.all([
          probeVideo(res.part1_path),
          probeVideo(res.part2_path),
        ]);
        applySplitInList(sourcePath, m1, m2);
        markSplit(res.part1_path, res.part2_path, sourcePath);
        opts?.onStatus?.(tr("video.edit.progress.splitDone"));
        showSuccess(
          tr("video.edit.success.split"),
          tr("common.actions.edit"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("video.edit.error.split"));
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, applySplitInList, markSplit, showError, showSuccess],
  );

  /** Edit value only — pixels are rotated once in the export encode. */
  const applyRotate = useCallback(
    (sourcePath: string, degrees: number) => {
      if (applying) return;
      const store = useVideoStore.getState();
      const next = normalizeClipRotation(store.getRotation(sourcePath) + degrees);
      setRotation(sourcePath, next);
      if (next !== 0) {
        markRotated(sourcePath);
      } else if (store.getCutMark(sourcePath) === "rotate") {
        clearCutMarksFor([sourcePath]);
      }
      showSuccess(
        tr("video.edit.success.rotate"),
        tr("common.actions.edit"),
        { autoCloseSecs: 5 },
      );
    },
    [applying, setRotation, markRotated, clearCutMarksFor, showSuccess],
  );

  const undoForPath = useCallback(
    async (path: string, opts?: ApplyOptions) => {
      if (applying) return;
      if (useVideoStore.getState().getCutMark(path) === "rotate") {
        clearRotationsFor([path]);
        clearCutMarksFor([path]);
        showSuccess(
          tr("video.edit.success.undoOne"),
          tr("common.actions.undo"),
          { autoCloseSecs: 5 },
        );
        return;
      }
      setApplying(true);
      beginProgress(opts, tr("video.edit.progress.undoOne"));
      try {
        const res = await undoVideoCutForPath(path);
        await applyUndoResult(res);
        opts?.onStatus?.(tr("video.edit.progress.undoDone"));
        showSuccess(
          tr("video.edit.success.undoOne"),
          tr("common.actions.undo"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("video.edit.error.undo"));
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, clearRotationsFor, clearCutMarksFor, showError, showSuccess],
  );

  const undoAll = useCallback(
    async (opts?: ApplyOptions) => {
      if (applying || !canUndo) return;
      setApplying(true);
      beginProgress(opts, tr("video.edit.progress.undoAll"));
      try {
        const marks = Object.values(useVideoStore.getState().cutMarks);
        const rotateOnly = marks.filter((m) => m === "rotate").length;
        const results =
          marks.length > rotateOnly ? await undoAllVideoCuts() : [];
        for (const res of results) {
          await applyUndoResult(res);
        }
        clearAllRotations();
        clearAllCutMarks();
        opts?.onStatus?.(tr("video.edit.progress.undoDone"));
        showSuccess(
          tr("video.edit.success.undoAll", { count: results.length + rotateOnly }),
          tr("common.actions.undo"),
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), tr("video.edit.error.undo"));
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, canUndo, clearAllCutMarks, clearAllRotations, showError, showSuccess],
  );

  /** @deprecated use undoAll — kept for callers that expected single undo */
  const undoLast = undoAll;

  return {
    applying,
    canUndo,
    applyTrim,
    applySplit,
    applyRotate,
    undoForPath,
    undoAll,
    undoLast,
    clearUndoState,
  };
}
