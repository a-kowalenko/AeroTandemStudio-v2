import { useCallback, useMemo, useState } from "react";
import { cutVideo, probeVideo, splitVideo } from "../lib/tauri";
import { useVideoStore } from "../store/videoStore";
import { useUiStore } from "../store/uiStore";

export type PendingVideoCut = {
  sourcePath: string;
  listIndex: number;
  kind: "trim" | "split";
  startMs?: number | null;
  endMs?: number | null;
  splitMs?: number | null;
};

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "?";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const frac = ms % 1000;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${frac
    .toString()
    .padStart(3, "0")}`;
}

export function pendingCutSummary(cut: PendingVideoCut): string {
  const name = basename(cut.sourcePath);
  if (cut.kind === "trim") {
    return `Trim: ${name}  (${fmtMs(cut.startMs)} – ${fmtMs(cut.endMs)})`;
  }
  return `Teilen: ${name}  bei ${fmtMs(cut.splitMs)}`;
}

type ApplyOptions = {
  onBusyChange?: (busy: boolean) => void;
  onProgressReset?: () => void;
};

/**
 * Queue of planned trim/split ops (legacy `pending_video_cut.py` + App batch).
 * Applying runs FFmpeg via `cut_video` / `split_video` and refreshes the video list.
 */
export function usePendingVideoCuts() {
  const [pending, setPending] = useState<PendingVideoCut[]>([]);
  const [applying, setApplying] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const replaceVideo = useVideoStore((s) => s.replaceVideo);
  const applySplitInList = useVideoStore((s) => s.applySplitInList);
  const videoList = useVideoStore((s) => s.videoList);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showWarning = useUiStore((s) => s.showWarning);
  const setLoading = useUiStore((s) => s.setLoading);

  const count = pending.length;
  const summaries = useMemo(() => pending.map(pendingCutSummary), [pending]);

  const enqueueTrim = useCallback(
    (sourcePath: string, listIndex: number, startMs: number, endMs: number) => {
      setPending((prev) => {
        const next = prev.filter((p) => p.sourcePath !== sourcePath);
        next.push({
          sourcePath,
          listIndex,
          kind: "trim",
          startMs,
          endMs,
        });
        return next;
      });
    },
    [],
  );

  const enqueueSplit = useCallback(
    (sourcePath: string, listIndex: number, splitMs: number) => {
      setPending((prev) => {
        const next = prev.filter((p) => p.sourcePath !== sourcePath);
        next.push({
          sourcePath,
          listIndex,
          kind: "split",
          splitMs,
        });
        return next;
      });
    },
    [],
  );

  const discardForPath = useCallback((path: string) => {
    setPending((prev) => prev.filter((p) => p.sourcePath !== path));
  }, []);

  const removeAt = useCallback((index: number) => {
    setPending((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAll = useCallback(() => setPending([]), []);

  const openReview = useCallback(() => {
    if (pending.length === 0) {
      showWarning("Es sind keine ausstehenden Schnitte geplant.", "Warteschlange");
      return;
    }
    setReviewOpen(true);
  }, [pending.length, showWarning]);

  const applyAll = useCallback(
    async (opts?: ApplyOptions) => {
      if (pending.length === 0 || applying) return;
      const snapshot = [...pending];
      setPending([]);
      setReviewOpen(false);
      setApplying(true);
      opts?.onBusyChange?.(true);
      opts?.onProgressReset?.();
      setLoading(true, `Schnitte anwenden (0/${snapshot.length})…`);

      let ok = 0;
      const errors: string[] = [];

      try {
        for (let i = 0; i < snapshot.length; i++) {
          const item = snapshot[i];
          setLoading(true, `Schnitte anwenden (${i + 1}/${snapshot.length})…`);
          try {
            if (item.kind === "trim") {
              const start = (item.startMs ?? 0) / 1000;
              const end = (item.endMs ?? 0) / 1000;
              await cutVideo({
                input: item.sourcePath,
                start,
                end,
                overwrite: true,
              });
              const meta = await probeVideo(item.sourcePath);
              replaceVideo(item.sourcePath, meta);
            } else {
              const splitSecs = (item.splitMs ?? 0) / 1000;
              const res = await splitVideo({
                input: item.sourcePath,
                splitSecs,
                overwrite: true,
              });
              const [m1, m2] = await Promise.all([
                probeVideo(res.part1_path),
                probeVideo(res.part2_path),
              ]);
              applySplitInList(item.sourcePath, m1, m2);
            }
            ok += 1;
          } catch (e) {
            errors.push(`${basename(item.sourcePath)}: ${e}`);
          }
        }

        if (errors.length === 0) {
          showSuccess(`${ok} Schnitt(e) angewendet.`);
        } else if (ok > 0) {
          showWarning(
            `${ok} ok, ${errors.length} Fehler:\n${errors.join("\n")}`,
            "Schnitte teilweise",
          );
        } else {
          showError(errors.join("\n"));
          setPending(snapshot);
        }
      } finally {
        setApplying(false);
        opts?.onBusyChange?.(false);
        setLoading(false);
      }
    },
    [
      pending,
      applying,
      replaceVideo,
      applySplitInList,
      showError,
      showSuccess,
      showWarning,
      setLoading,
    ],
  );

  /** Resolve list index for a path (fallback when cutter opened from preview). */
  const indexForPath = useCallback(
    (path: string) => videoList.findIndex((v) => v.path === path),
    [videoList],
  );

  return {
    pending,
    count,
    summaries,
    applying,
    reviewOpen,
    setReviewOpen,
    enqueueTrim,
    enqueueSplit,
    discardForPath,
    removeAt,
    clearAll,
    openReview,
    applyAll,
    indexForPath,
  };
}
