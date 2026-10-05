import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogActionRows } from "@/components/DialogActionRows";
import { cn } from "@/lib/utils";
import {
  SESSION_OUTCOME_EXIT_MS,
  sessionOutcomeHideMs,
  type SessionRunOutcome,
} from "@/lib/sessionRunOutcome";

type Props = {
  outcome: SessionRunOutcome;
  onDismiss: () => void;
  className?: string;
};

/**
 * Non-modal import/SD completion card: auto-hides with a bottom timer bar.
 * Hover pauses the timer; dismiss/X plays a short float-out before clearing.
 */
export function SessionOutcomeCard({ outcome, onDismiss, className }: Props) {
  const { t } = useTranslation();
  const warning = outcome.tone === "warning";
  const OutcomeIcon = warning ? AlertTriangle : CheckCircle2;
  const totalMs = sessionOutcomeHideMs({
    queuedNext: outcome.queuedNext,
    tone: outcome.tone,
  });

  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);

  const remainingRef = useRef(totalMs);
  const segmentStartedRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const beginExit = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    clearTimer();
    setExiting(true);
    window.setTimeout(() => {
      onDismissRef.current();
    }, SESSION_OUTCOME_EXIT_MS);
  }, [clearTimer]);

  const armTimer = useCallback(
    (ms: number) => {
      clearTimer();
      remainingRef.current = ms;
      segmentStartedRef.current = Date.now();
      timerRef.current = window.setTimeout(() => beginExit(), ms);
    },
    [beginExit, clearTimer],
  );

  useEffect(() => {
    dismissedRef.current = false;
    setExiting(false);
    setPaused(false);
    armTimer(totalMs);
    return clearTimer;
  }, [outcome.id, totalMs, armTimer, clearTimer]);

  function captureRemaining() {
    if (segmentStartedRef.current == null) return;
    const elapsed = Date.now() - segmentStartedRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    segmentStartedRef.current = null;
  }

  function onMouseEnter() {
    if (exiting || dismissedRef.current || paused) return;
    setPaused(true);
    clearTimer();
    captureRemaining();
  }

  function onMouseLeave() {
    if (exiting || dismissedRef.current || !paused) return;
    setPaused(false);
    if (remainingRef.current <= 0) {
      beginExit();
      return;
    }
    armTimer(remainingRef.current);
  }

  return (
    <section
      className={cn(
        "ats-surface relative pointer-events-auto overflow-hidden rounded-xl border p-4 pb-5 shadow-lg backdrop-blur-md",
        exiting ? "ats-progress-float-out" : "ats-progress-float-in",
        warning ? "border-warning/50" : "border-border/80",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={t("workflow.sessionOutcome.aria")}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeIcon
              className={cn(
                "h-4 w-4 shrink-0",
                warning ? "text-warning" : "text-success",
              )}
              aria-hidden
            />
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              {outcome.title || t("common.status.success")}
            </h2>
          </div>
          {outcome.highlight ? (
            <p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
              {outcome.highlight}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label={t("workflow.sessionOutcome.dismiss")}
          disabled={exiting}
          onClick={beginExit}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto pr-0.5">
        <DialogActionRows actions={outcome.actions} compact />
      </div>

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden",
          warning ? "bg-warning/20" : "bg-success/20",
        )}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("dialogs.autoCloseAria")}
      >
        <div
          key={outcome.id}
          className={cn(
            "h-full w-full origin-left ats-toast-progress",
            warning ? "bg-warning" : "bg-success",
          )}
          style={{
            animationDuration: `${totalMs}ms`,
            animationPlayState:
              paused || exiting ? "paused" : "running",
          }}
        />
      </div>
    </section>
  );
}
