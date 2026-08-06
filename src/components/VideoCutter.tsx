import { useRef, useState } from "react";
import { Scissors, SplitSquareHorizontal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { VideoPlayer, type VideoPlayerHandle } from "./VideoPlayer";
import { useUiStore } from "../store/uiStore";

export type VideoCutterResult =
  | { action: "cancel" }
  | { action: "queue_trim"; startMs: number; endMs: number }
  | { action: "queue_split"; splitMs: number };

type VideoCutterProps = {
  open: boolean;
  videoPath: string | null;
  durationSecsHint?: number;
  onClose: () => void;
  onComplete: (result: VideoCutterResult) => void;
};

/**
 * Modal cutter UI (legacy `video_cutter.py`): set IN/OUT or split at playhead,
 * then enqueue — FFmpeg runs via the pending-cuts batch.
 */
export function VideoCutter({
  open,
  videoPath,
  durationSecsHint,
  onClose,
  onComplete,
}: VideoCutterProps) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const committedRef = useRef(false);
  const showWarning = useUiStore((s) => s.showWarning);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [endMs, setEndMs] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState(
    durationSecsHint && durationSecsHint > 0 ? durationSecsHint * 1000 : 0,
  );

  function resetMarks() {
    setStartMs(null);
    setEndMs(null);
  }

  function finish(result: VideoCutterResult) {
    committedRef.current = true;
    playerRef.current?.pause();
    onComplete(result);
    resetMarks();
    onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      committedRef.current = false;
      return;
    }
    if (!committedRef.current) {
      onComplete({ action: "cancel" });
    }
    committedRef.current = false;
    resetMarks();
    onClose();
  }

  function setIn() {
    const t = playerRef.current?.getCurrentTimeMs() ?? 0;
    if (endMs != null && t > endMs) {
      setStartMs(endMs);
      setEndMs(t);
    } else {
      setStartMs(t);
    }
  }

  function setOut() {
    const t = playerRef.current?.getCurrentTimeMs() ?? 0;
    if (startMs != null && t < startMs) {
      setEndMs(startMs);
      setStartMs(t);
    } else {
      setEndMs(t);
    }
  }

  function queueTrim() {
    if (startMs == null && endMs == null) {
      showWarning(
        "Sie haben keinen IN- oder OUT-Punkt gesetzt. Es gibt nichts zu schneiden.",
        "Keine Änderung",
      );
      return;
    }
    let s = startMs ?? 0;
    let e = endMs ?? durationMs;
    if (e < s) [s, e] = [e, s];
    if (e - s < 100) {
      showWarning("Der behaltene Bereich ist zu kurz.", "Ungültiger Schnitt");
      return;
    }
    finish({ action: "queue_trim", startMs: s, endMs: e });
  }

  function queueSplit() {
    const splitMs = playerRef.current?.getCurrentTimeMs() ?? 0;
    const total = playerRef.current?.getDurationMs() || durationMs;
    if (splitMs <= 100 || splitMs >= total - 100) {
      showWarning(
        "Sie können nicht zu nah am Anfang oder Ende des Clips teilen.",
        "Ungültiger Split-Punkt",
      );
      return;
    }
    finish({ action: "queue_split", splitMs });
  }

  const keepRange =
    durationMs > 0
      ? {
          start: (startMs ?? 0) / durationMs,
          end: (endMs ?? durationMs) / durationMs,
        }
      : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" />
            Video schneiden
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {videoPath ?? "—"}
          </DialogDescription>
        </DialogHeader>

        <VideoPlayer
          ref={playerRef}
          srcPath={open ? videoPath : null}
          keepRange={keepRange}
          onTimeUpdate={(_c, d) => {
            if (d > 0) setDurationMs(d);
          }}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={setIn}>
            IN setzen
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={setOut}>
            OUT setzen
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={resetMarks}>
            Marken löschen
          </Button>
          <span className="ml-auto self-center font-mono text-xs text-muted">
            IN {startMs != null ? `${(startMs / 1000).toFixed(2)}s` : "—"} · OUT{" "}
            {endMs != null ? `${(endMs / 1000).toFixed(2)}s` : "—"}
          </span>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
            Abbrechen
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={queueSplit}>
              <SplitSquareHorizontal className="h-4 w-4" />
              Teilen in Warteschlange
            </Button>
            <Button type="button" onClick={queueTrim}>
              <Scissors className="h-4 w-4" />
              Trim in Warteschlange
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
