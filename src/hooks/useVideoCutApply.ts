import { useCallback, useState } from "react";
import {
  cutVideo,
  probeVideo,
  splitVideo,
  undoAllVideoCuts,
  undoVideoCutForPath,
  type UndoCutResult,
} from "../lib/tauri";
import { useVideoStore } from "../store/videoStore";
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

  if (res.kind === "split" && res.removed_paths.length >= 2) {
    const meta = await probeVideo(res.restore_path);
    restoreAfterSplitUndo(res.removed_paths[0]!, res.removed_paths[1]!, meta);
  } else {
    const meta = await probeVideo(res.restore_path);
    replaceVideo(res.restore_path, meta);
  }
  clearCutMarksFor(res.cleared_mark_paths?.length ? res.cleared_mark_paths : [res.restore_path]);
}

/**
 * Apply trim/split immediately. Multi-clip undo via working-copy backups.
 * Progress uses the sticky top ProgressIndicator (same as encode) — no blur overlay.
 */
export function useVideoCutApply() {
  const [applying, setApplying] = useState(false);

  const cutMarks = useVideoStore((s) => s.cutMarks);
  const canUndo = Object.keys(cutMarks).length > 0;
  const replaceVideo = useVideoStore((s) => s.replaceVideo);
  const applySplitInList = useVideoStore((s) => s.applySplitInList);
  const markTrimmed = useVideoStore((s) => s.markTrimmed);
  const markSplit = useVideoStore((s) => s.markSplit);
  const clearAllCutMarks = useVideoStore((s) => s.clearAllCutMarks);
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
      beginProgress(opts, "Schnitt wird angewendet…");
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
        opts?.onStatus?.("Schnitt fertig");
        showSuccess(
          "Schnitt übernommen. Rückgängig über den Clip oder „Alle Schnitte rückgängig“.",
          "Schnitt",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Schnitt fehlgeschlagen");
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
      beginProgress(opts, "Video wird geteilt…");
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
        opts?.onStatus?.("Teilen fertig");
        showSuccess(
          "Video geteilt. Rückgängig über einen Teil-Clip oder „Alle Schnitte rückgängig“.",
          "Teilen",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Teilen fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, applySplitInList, markSplit, showError, showSuccess],
  );

  const undoForPath = useCallback(
    async (path: string, opts?: ApplyOptions) => {
      if (applying) return;
      setApplying(true);
      beginProgress(opts, "Schnitt wird rückgängig gemacht…");
      try {
        const res = await undoVideoCutForPath(path);
        await applyUndoResult(res);
        opts?.onStatus?.("Rückgängig fertig");
        showSuccess("Schnitt für diesen Clip rückgängig gemacht.", "Rückgängig", {
          autoCloseSecs: 5,
        });
      } catch (e) {
        showError(String(e), "Rückgängig fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, showError, showSuccess],
  );

  const undoAll = useCallback(
    async (opts?: ApplyOptions) => {
      if (applying || !canUndo) return;
      setApplying(true);
      beginProgress(opts, "Alle Schnitte werden rückgängig gemacht…");
      try {
        const results = await undoAllVideoCuts();
        for (const res of results) {
          await applyUndoResult(res);
        }
        clearAllCutMarks();
        opts?.onStatus?.("Rückgängig fertig");
        showSuccess(
          `${results.length} Schnitt-Aktion(en) rückgängig gemacht.`,
          "Rückgängig",
          { autoCloseSecs: 5 },
        );
      } catch (e) {
        showError(String(e), "Rückgängig fehlgeschlagen");
      } finally {
        setApplying(false);
        endProgress(opts);
      }
    },
    [applying, canUndo, clearAllCutMarks, showError, showSuccess],
  );

  /** @deprecated use undoAll — kept for callers that expected single undo */
  const undoLast = undoAll;

  return {
    applying,
    canUndo,
    applyTrim,
    applySplit,
    undoForPath,
    undoAll,
    undoLast,
    clearUndoState,
  };
}
