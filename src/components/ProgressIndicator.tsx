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
  /** Per-task bars when parallel encoding is active */
  tasks?: TaskProgress[];
};

function Bar({
  percent,
  tone = "primary",
}: {
  percent: number;
  tone?: "primary" | "secondary";
}) {
  const clamped = Math.max(0, Math.min(100, percent));
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
          background:
            tone === "primary"
              ? "linear-gradient(90deg, var(--ats-progress-from), var(--ats-progress-to))"
              : "linear-gradient(90deg, color-mix(in srgb, var(--ats-progress-from) 70%, #fff), var(--ats-progress-to))",
        }}
      />
    </div>
  );
}

export function ProgressIndicator({ percent, label, tasks }: ProgressIndicatorProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const showTasks = tasks && tasks.length > 0;

  return (
    <div className="space-y-3">
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Gesamtfortschritt"}
        className="space-y-1.5"
      >
        <div className="flex items-baseline justify-between gap-3">
          {label ? (
            <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</p>
          ) : (
            <span />
          )}
          <p className="shrink-0 text-sm tabular-nums text-muted">{clamped.toFixed(1)}%</p>
        </div>
        <Bar percent={clamped} />
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
                  <p className="min-w-0 flex-1 truncate text-xs text-muted" title={taskLabel}>
                    {taskLabel}
                  </p>
                  <p className="shrink-0 text-xs tabular-nums text-muted">{pct.toFixed(1)}%</p>
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
