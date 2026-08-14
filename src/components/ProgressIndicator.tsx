import type { QrClipScanPace, QrFileProgress } from "../store/qrScanStore";

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
  /** Primary counter, e.g. `2/5`. */
  metric?: string;
  /** Unit next to metric, e.g. `Videos`. */
  metricLabel?: string;
  /** Show Schnell/Gründlich color legend under QR stripes. */
  paceLegend?: boolean;
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
            ? "h-full rounded-full transition-[width] duration-300 ease-out"
            : "h-full rounded-full opacity-90 transition-[width] duration-300 ease-out"
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
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted"
      aria-label="Farblegende"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: FAST_SOLID }}
          aria-hidden
        />
        Schnellprüfung
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-1.5 w-3 rounded-full"
          style={{ background: THOROUGH_SOLID }}
          aria-hidden
        />
        Gründliche Prüfung
      </span>
    </div>
  );
}

/** One column per file in list order; Prüfpunkte label under each active stripe. */
function FileSegments({
  progress,
  showLegend,
}: {
  progress: QrFileProgress;
  showLegend?: boolean;
}) {
  const { segments, finished, total } = progress;
  if (total <= 0 || segments.length === 0) return null;

  const maxSegments = 24;

  if (segments.length > maxSegments) {
    const pctDone = Math.round((finished / total) * 100);
    return (
      <div className="space-y-1.5">
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label={`${finished} von ${total} Dateien erledigt`}
        >
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{
                width: `${pctDone}%`,
                background: FAST_FILL,
              }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted">
            {finished}/{total}
          </span>
        </div>
        {showLegend ? <PaceLegend /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div
        className="flex gap-1"
        role="group"
        aria-label={`${finished} von ${total} Dateien (Listenreihenfolge)`}
      >
        {segments.map((seg) => {
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
            isActive &&
            seg.framesTotal != null &&
            seg.framesTotal > 0 &&
            pace !== "prepare"
              ? `${seg.frame ?? 0}/${seg.framesTotal}`
              : isActive && pace === "prepare"
                ? "…"
                : "\u00a0";
          const title = hit
            ? "Treffer"
            : done
              ? "erledigt"
              : isActive && seg.framesTotal
                ? `${pace === "thorough" ? "Gründlich" : "Schnell"} · ${seg.frame ?? 0}/${seg.framesTotal}`
                : isActive
                  ? pace === "thorough"
                    ? "Gründliche Prüfung"
                    : "Schnellprüfung"
                  : "ausstehend";

          return (
            <div
              key={seg.key}
              className="flex min-w-0 flex-1 flex-col items-stretch gap-0.5"
              title={title}
            >
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border/60">
                {done ? (
                  <div
                    className="absolute inset-0 rounded-full"
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
                        ? "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out"
                        : "absolute inset-0 animate-pulse rounded-full"
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
            </div>
          );
        })}
      </div>
      {showLegend ? <PaceLegend /> : null}
    </div>
  );
}

export function ProgressIndicator({
  percent,
  label,
  indeterminate = false,
  hidePercent = false,
  metric,
  metricLabel,
  paceLegend = false,
  fileProgress,
  tasks,
}: ProgressIndicatorProps) {
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

  return (
    <div className="space-y-3">
      <div
        role="progressbar"
        aria-valuenow={useActivity ? undefined : clamped}
        aria-valuemin={useActivity ? undefined : 0}
        aria-valuemax={useActivity ? undefined : 100}
        aria-valuetext={
          hidePercent && metric
            ? metricLabel
              ? `${metric} ${metricLabel}`
              : metric
            : undefined
        }
        aria-label={label ?? "Gesamtfortschritt"}
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
          {hidePercent && metric ? (
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
          ) : !hidePercent ? (
            <p className="shrink-0 text-sm tabular-nums text-muted">
              {statusText ?? (indeterminate ? "…" : `${clamped.toFixed(1)}%`)}
            </p>
          ) : (
            <p className="shrink-0 text-sm text-muted" aria-hidden>
              ···
            </p>
          )}
        </div>
        {fileProgress && fileProgress.total > 0 ? (
          <FileSegments progress={fileProgress} showLegend={paceLegend} />
        ) : (
          <Bar percent={clamped} indeterminate={useActivity} />
        )}
      </div>

      {showTasks ? (
        <div className="space-y-2.5 border-l-2 border-primary/30 pl-3">
          {tasks.map((t) => {
            const pct = Math.max(0, Math.min(100, t.percent));
            const taskLabel =
              t.label?.trim() ||
              (t.status ? `Clip ${t.taskId} — ${t.status}` : `Clip ${t.taskId}`);
            return (
              <div
                key={t.taskId}
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
