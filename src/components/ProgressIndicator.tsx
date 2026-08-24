import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  QrClipScanPace,
  QrFileProgress,
  QrScanLegend,
} from "../store/qrScanStore";

type TaskProgress = {
  taskId: number;
  percent: number;
  /** Human-readable label (clip name / activity) */
  label?: string;
  status?: string;
};

type ProgressIndicatorProps = {
  percent: number;
  label?: string;
  /** Animated bar without a meaningful percentage (import / waiting). */
  indeterminate?: boolean;
  /** Hide % (QR scan early-exit); show metric instead. */
  hidePercent?: boolean;
  /**
   * Hide the overall progress bar (and percent). Label + optional task bars remain.
   * Used for create-job when the pipeline stepper replaces the overall bar.
   */
  hideBar?: boolean;
  /** Primary counter, e.g. `2/5`. */
  metric?: string;
  /** Unit next to metric, e.g. `Videos`. */
  metricLabel?: string;
  /** Color legend under QR stripes. */
  legend?: QrScanLegend;
  /** Discrete file segments for batch QR progress (media list order). */
  fileProgress?: QrFileProgress;
  /** Per-task bars when parallel encoding is active */
  tasks?: TaskProgress[];
};

const FAST_FILL =
  "linear-gradient(90deg, var(--ats-progress-from), var(--ats-progress-to))";
const THOROUGH_FILL = "linear-gradient(90deg, #d97706, #f59e0b)";
const FAST_SOLID = "var(--ats-progress-from)";
const THOROUGH_SOLID = "#d97706";
const REMOVED_SOLID = "var(--ats-destructive)";
const PREPARE_FILL =
  "color-mix(in srgb, var(--ats-progress-from) 40%, transparent)";

function paceFill(pace: QrClipScanPace | undefined, solid: boolean): string {
  if (pace === "thorough") return solid ? THOROUGH_SOLID : THOROUGH_FILL;
  if (pace === "prepare") return PREPARE_FILL;
  return solid ? FAST_SOLID : FAST_FILL;
}

function Bar({
  percent,
  tone = "primary",
  indeterminate = false,
}: {
  percent: number;
  tone?: "primary" | "secondary";
  indeterminate?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const prevRef = useRef(clamped);
  const drop = prevRef.current - clamped;
  prevRef.current = clamped;
  // Large drops (e.g. video 100% → sort 0%) must not ease from the old width.
  const animateWidth = drop < 20;
  const gradient =
    tone === "primary"
      ? FAST_FILL
      : "linear-gradient(90deg, color-mix(in srgb, var(--ats-progress-from) 70%, #fff), var(--ats-progress-to))";

  if (indeterminate) {
    return (
      <div className="h-2.5 overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full w-1/3 rounded-full opacity-90"
          style={{
            background: gradient,
            animation: "ats-progress-indeterminate 1.2s ease-in-out infinite",
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-border/60">
      <div
        className={
          tone === "primary"
            ? animateWidth
              ? "h-full rounded-full transition-[width] duration-300 ease-out"
              : "h-full rounded-full"
            : animateWidth
              ? "h-full rounded-full opacity-90 transition-[width] duration-300 ease-out"
              : "h-full rounded-full opacity-90"
        }
        style={{
          width: `${clamped}%`,
          background: gradient,
        }}
      />
    </div>
  );
}

function PaceLegend() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted"
      aria-label={t("progress.legend.aria")}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: FAST_SOLID }}
          aria-hidden
        />
        {t("progress.legend.fast")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: THOROUGH_SOLID }}
          aria-hidden
        />
        {t("progress.legend.thorough")}
      </span>
    </div>
  );
}

function FollowupLegend() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted"
      aria-label={t("progress.legend.aria")}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: FAST_SOLID }}
          aria-hidden
        />
        {t("progress.legend.checked")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: REMOVED_SOLID }}
          aria-hidden
        />
        {t("progress.legend.removed")}
      </span>
    </div>
  );
}

/** One column per file in list order; Prüfpunkte label under each active stripe. */
function FileSegments({
  progress,
  legend,
}: {
  progress: QrFileProgress;
  legend?: QrScanLegend;
}) {
  const { t } = useTranslation();
  const { segments, finished, total } = progress;
  if (total <= 0 || segments.length === 0) return null;

  const legendEl =
    legend === "pace" ? (
      <PaceLegend />
    ) : legend === "followup" ? (
      <FollowupLegend />
    ) : null;

  // Always keep one stripe per file (removed/hit must stay visible).
  // Dense batches: tighter gaps and hide under-stripe Prüfpunkte labels.
  const dense = segments.length > 24;
  const showPointLabels =
    !dense &&
    segments.some(
      (s) =>
        s.phase === "active" &&
        s.framesTotal != null &&
        s.framesTotal > 0 &&
        s.pace !== "prepare",
    );

  return (
    <div className="space-y-1.5">
      <div
        className={dense ? "flex gap-px" : "flex gap-1"}
        role="group"
        aria-label={t("progress.filesAria", { finished, total })}
      >
        {segments.map((seg) => {
          const removed = seg.phase === "removed";
          const done = seg.phase === "done" || seg.phase === "hit";
          const isActive = seg.phase === "active";
          const hit = seg.phase === "hit";
          const pace = seg.pace ?? (isActive ? "fast" : undefined);
          const framePct =
            isActive && seg.framesTotal != null && seg.framesTotal > 0
              ? Math.max(
                  8,
                  Math.min(
                    100,
                    Math.round(
                      (Math.max(0, seg.frame ?? 0) / seg.framesTotal) * 100,
                    ),
                  ),
                )
              : isActive
                ? 40
                : 0;
          const pointLabel =
            showPointLabels &&
            isActive &&
            seg.framesTotal != null &&
            seg.framesTotal > 0 &&
            pace !== "prepare"
              ? `${seg.frame ?? 0}/${seg.framesTotal}`
              : showPointLabels && isActive && pace === "prepare"
                ? "…"
                : "\u00a0";
          const title = removed
            ? t("progress.seg.removed")
            : hit
              ? t("progress.seg.hit")
              : done
                ? t("progress.seg.done")
                : isActive && seg.framesTotal
                  ? t("progress.seg.paceFrames", {
                      pace:
                        pace === "thorough"
                          ? t("progress.seg.thoroughShort")
                          : t("progress.seg.fastShort"),
                      frame: seg.frame ?? 0,
                      total: seg.framesTotal,
                    })
                  : isActive
                    ? pace === "thorough"
                      ? t("progress.legend.thorough")
                      : t("progress.legend.fast")
                    : t("progress.seg.pending");

          return (
            <div
              key={seg.key}
              className="flex min-w-0 flex-1 flex-col items-stretch gap-0.5"
              title={title}
            >
              <div
                className={
                  dense
                    ? "relative h-1 w-full overflow-hidden rounded-sm bg-border/60"
                    : "relative h-1.5 w-full overflow-hidden rounded-full bg-border/60"
                }
              >
                {removed ? (
                  <div
                    className="absolute inset-0 rounded-[inherit]"
                    style={{ background: REMOVED_SOLID }}
                  />
                ) : done ? (
                  <div
                    className="absolute inset-0 rounded-[inherit]"
                    style={{
                      background: hit
                        ? paceFill("fast", false)
                        : paceFill("fast", true),
                    }}
                  />
                ) : isActive ? (
                  <div
                    className={
                      seg.framesTotal && pace !== "prepare"
                        ? "absolute inset-y-0 left-0 rounded-[inherit] transition-[width] duration-300 ease-out"
                        : "absolute inset-0 animate-pulse rounded-[inherit]"
                    }
                    style={{
                      width:
                        seg.framesTotal && pace !== "prepare"
                          ? `${framePct}%`
                          : "100%",
                      background: paceFill(pace, false),
                    }}
                  />
                ) : null}
              </div>
              {showPointLabels ? (
                <p
                  className={
                    isActive && pointLabel !== "\u00a0"
                      ? "text-center text-[10px] leading-tight tabular-nums text-foreground"
                      : "text-center text-[10px] leading-tight tabular-nums text-transparent"
                  }
                  aria-hidden={pointLabel === "\u00a0"}
                >
                  {pointLabel}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {legendEl}
    </div>
  );
}

export function ProgressIndicator({
  percent,
  label,
  indeterminate = false,
  hidePercent = false,
  hideBar = false,
  metric,
  metricLabel,
  legend,
  fileProgress,
  tasks,
}: ProgressIndicatorProps) {
  const { t } = useTranslation();
  const clamped = Math.max(0, Math.min(100, percent));
  const showTasks = tasks && tasks.length > 0;
  const useActivity = indeterminate || hidePercent;
  const statusText =
    hidePercent && metric
      ? metricLabel
        ? `${metric} ${metricLabel}`
        : metric
      : useActivity
        ? undefined
        : `${clamped.toFixed(1)}%`;

  const showOverallChrome = !hideBar || Boolean(label) || Boolean(fileProgress);

  return (
    <div className="space-y-3">
      {showOverallChrome ? (
        <div
          role={hideBar ? "status" : "progressbar"}
          aria-valuenow={hideBar || useActivity ? undefined : clamped}
          aria-valuemin={hideBar || useActivity ? undefined : 0}
          aria-valuemax={hideBar || useActivity ? undefined : 100}
          aria-valuetext={
            hidePercent && metric
              ? metricLabel
                ? `${metric} ${metricLabel}`
                : metric
              : undefined
          }
          aria-label={label ?? t("progress.overallAria")}
          className="space-y-1.5"
        >
          <div className="flex items-baseline justify-between gap-3">
            {label ? (
              <p
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                title={label}
              >
                {label}
              </p>
            ) : (
              <span />
            )}
            {!hideBar && hidePercent && metric ? (
              <p className="shrink-0 text-right">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {metric}
                </span>
                {metricLabel ? (
                  <span className="ml-1.5 text-[11px] text-muted">
                    {metricLabel}
                  </span>
                ) : null}
              </p>
            ) : !hideBar && !hidePercent ? (
              <p className="shrink-0 text-sm tabular-nums text-muted">
                {statusText ?? (indeterminate ? "…" : `${clamped.toFixed(1)}%`)}
              </p>
            ) : !hideBar ? (
              <p className="shrink-0 text-sm text-muted" aria-hidden>
                ···
              </p>
            ) : null}
          </div>
          {!hideBar ? (
            fileProgress && fileProgress.total > 0 ? (
              <FileSegments progress={fileProgress} legend={legend} />
            ) : (
              <Bar percent={clamped} indeterminate={useActivity} />
            )
          ) : null}
        </div>
      ) : null}

      {showTasks ? (
        <div className="space-y-2.5 border-l-2 border-primary/30 pl-3">
          {tasks.map((task) => {
            const pct = Math.max(0, Math.min(100, task.percent));
            const taskLabel =
              task.label?.trim() ||
              (task.status
                ? t("progress.clipStatus", { id: task.taskId, status: task.status })
                : t("progress.clipOnly", { id: task.taskId }));
            return (
              <div
                key={task.taskId}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={taskLabel}
                className="space-y-1"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p
                    className="min-w-0 flex-1 truncate text-xs text-muted"
                    title={taskLabel}
                  >
                    {taskLabel}
                  </p>
                  <p className="shrink-0 text-xs tabular-nums text-muted">
                    {pct.toFixed(1)}%
                  </p>
                </div>
                <Bar percent={pct} tone="secondary" />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
