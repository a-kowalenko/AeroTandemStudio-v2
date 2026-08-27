import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  Download,
  Eraser,
  Eye,
  FilePlus2,
  HardDrive,
  Loader2,
  QrCode,
  Scissors,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProgressIndicator } from "./ProgressIndicator";
import { CreateJobPipelineStepper } from "./CreateJobPipelineStepper";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { WorkflowProgressStage } from "../lib/workflowProgress";
import type { UploadQueueJobPreview } from "../lib/uploadQueue";
import type { WorkflowProgressView } from "../hooks/useWorkflowProgress";

type Props = {
  view: WorkflowProgressView;
  onCancel?: () => void;
  className?: string;
};

function stageIcon(stage: WorkflowProgressStage): LucideIcon {
  switch (stage) {
    case "sd-backup":
      return HardDrive;
    case "sd-import":
    case "import":
      return Download;
    case "sd-clear":
      return Eraser;
    case "sd-qr":
    case "qr":
      return QrCode;
    case "preview":
      return Eye;
    case "cut":
      return Scissors;
    case "append":
      return FilePlus2;
    case "done":
      return CheckCircle2;
    default:
      return Clapperboard;
  }
}

function formatQueueJobLine(
  job: UploadQueueJobPreview,
  t: (key: string, options?: { name?: string }) => string,
): string {
  const guest =
    job.guestLabel?.trim() ||
    job.folderName?.trim() ||
    t("workflow.upload.queueUntitled");
  const crew: string[] = [];
  if (job.tandemmaster) {
    crew.push(t("history.ta", { name: job.tandemmaster }));
  }
  if (job.videospringer) {
    crew.push(t("history.vs", { name: job.videospringer }));
  }
  return crew.length > 0 ? `${guest} — ${crew.join(" · ")}` : guest;
}

function UploadQueueCollapsible({
  jobs,
}: {
  jobs: UploadQueueJobPreview[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (jobs.length === 0) return null;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md text-left text-xs text-muted hover:text-foreground"
        aria-expanded={open}
        aria-label={
          open
            ? t("workflow.upload.queueCollapse")
            : t("workflow.upload.queueExpand")
        }
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span>
          {t("workflow.upload.queueWaiting", { count: jobs.length })}
        </span>
      </button>
      {open ? (
        <ul className="space-y-0.5 border-l border-border/60 pl-3">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="truncate text-xs text-muted"
              title={formatQueueJobLine(job, t)}
            >
              {formatQueueJobLine(job, t)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CompactUploadBar({ view }: { view: WorkflowProgressView }) {
  const { t } = useTranslation();
  const compact = view.uploadCompact;
  const pct = Math.round(compact.percent);
  const barWidth = view.uploadFailedHold
    ? Math.max(0, Math.min(100, compact.percent || view.snapshot?.percent || 0))
    : compact.percent > 0
      ? compact.percent
      : 8;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
      role="status"
      aria-live="polite"
    >
      {/* Chevron on the left — away from bottom-right Cancel in expanded view. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        aria-expanded={!view.collapsed}
        aria-label={
          view.collapsed
            ? t("workflow.upload.expand")
            : t("workflow.upload.collapse")
        }
        onClick={view.onToggleCollapsed}
      >
        {view.collapsed ? (
          <ChevronUp className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4" aria-hidden />
        )}
      </Button>

      <Upload
        className="h-4 w-4 shrink-0 text-primary"
        aria-hidden
      />
      <span className="shrink-0 text-sm font-medium text-foreground">
        {view.cancelling
          ? view.uploadCancelPhase === "cleanup"
            ? t("workflow.upload.cleaningUp")
            : t("common.actions.cancelling")
          : t("app.upload.title")}
      </span>

      <div
        className="h-2 min-w-[4.5rem] flex-1 overflow-hidden rounded-full bg-border/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.uploadFailedHold ? undefined : pct}
        aria-label={t("app.upload.title")}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            view.uploadFailedHold
              ? "bg-destructive/80"
              : "bg-[linear-gradient(90deg,var(--ats-progress-from),var(--ats-progress-to))]",
          )}
          style={{
            width: `${barWidth}%`,
            opacity: compact.percent > 0 || view.uploadFailedHold ? 1 : 0.55,
          }}
        />
      </div>

      <span className="shrink-0 text-xs tabular-nums text-muted">
        {view.uploadFailedHold ? "—" : `${pct}%`}
      </span>

      {compact.bytesLabel ? (
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {compact.bytesLabel}
        </span>
      ) : null}

      {compact.speedLabel ? (
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {compact.speedLabel}
        </span>
      ) : null}

      {view.uploadQueueCount > 0 ? (
        <span className="shrink-0 text-[11px] text-muted">
          {t("create.success.uploadQueued", { count: view.uploadQueueCount })}
        </span>
      ) : null}

      {view.uploadFailedHold ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-8 w-8 shrink-0 p-0"
          aria-label={t("common.actions.close")}
          onClick={view.onDismissFailedHold}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export function WorkflowProgressPanel({ view, onCancel, className }: Props) {
  const { t } = useTranslation();
  if (!view.visible) return null;

  const Icon = stageIcon(view.stage);
  const snapshot = view.snapshot;
  const cancelling = view.cancelling;
  const subtitle = cancelling
    ? t("workflow.stage.cancelling")
    : view.subtitle;
  const pipeline = view.createPipeline;
  const hideOverallBar = view.hideOverallBar;
  const showTasks =
    view.tasks.length > 0 &&
    (view.stage === "create" ||
      view.stage === "append" ||
      view.stage === "preview" ||
      view.stage === "cut" ||
      Boolean(pipeline));

  // Phase 37.2: compact upload bar (always with progress) + expandable details.
  if (view.backgroundUpload) {
    return (
      <section
        className={cn(
          "ats-surface pointer-events-auto rounded-xl border border-border/80 px-3 py-2.5 shadow-lg backdrop-blur-md ats-progress-float-in",
          className,
        )}
        aria-label={t("app.upload.title")}
        aria-busy={cancelling || undefined}
      >
        <CompactUploadBar view={view} />

        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
            view.collapsed
              ? "grid-rows-[0fr] opacity-0"
              : "grid-rows-[1fr] opacity-100",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex items-end gap-3 pt-2.5">
              <div className="min-w-0 flex-1 space-y-2.5">
                <p className="text-xs text-muted" aria-live="polite">
                  {subtitle}
                </p>
                {pipeline ? (
                  <div
                    className={cn(
                      "transition-opacity duration-300",
                      cancelling && "opacity-55",
                    )}
                  >
                    <CreateJobPipelineStepper view={pipeline} />
                  </div>
                ) : null}
                {/* Bytes/speed live in CompactUploadBar — skip snapshot.detail duplicate. */}
                <UploadQueueCollapsible jobs={view.uploadQueueJobs} />
              </div>
              {view.canCancel && onCancel ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  disabled={cancelling}
                  aria-busy={cancelling || undefined}
                  onClick={onCancel}
                >
                  {cancelling ? (
                    <>
                      <Loader2
                        className="h-3.5 w-3.5 shrink-0 animate-spin"
                        aria-hidden
                      />
                      {view.uploadCancelPhase === "cleanup"
                        ? t("workflow.upload.cleaningUp")
                        : t("common.actions.cancelling")}
                    </>
                  ) : (
                    t("common.actions.cancel")
                  )}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (view.collapsed) {
    const label =
      pipeline && !pipeline.completed && !pipeline.cancelled
        ? t(pipeline.steps[pipeline.activeIndex]?.labelKey ?? "workflow.progress")
        : (snapshot?.label ?? view.encodeLabel);
    return (
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-2 rounded-full border border-border/80 bg-card/95 px-3 py-2 shadow-lg backdrop-blur-md ats-progress-float-in",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm text-foreground" title={label}>
          {label}
        </p>
      </div>
    );
  }

  return (
    <section
      className={cn(
        "ats-surface pointer-events-auto rounded-xl border border-border/80 p-4 shadow-lg backdrop-blur-md ats-progress-float-in",
        className,
      )}
      aria-label={t("workflow.progress")}
      aria-busy={cancelling || undefined}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              {t("workflow.progress")}
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted" aria-live="polite">
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view.canCancel && onCancel ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={cancelling}
              aria-busy={cancelling || undefined}
              onClick={onCancel}
            >
              {cancelling ? (
                <>
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                  {t("common.actions.cancelling")}
                </>
              ) : (
                t("common.actions.cancel")
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {pipeline ? (
        <div
          className={cn(
            "mb-3 transition-opacity duration-300",
            cancelling && "opacity-55",
          )}
        >
          <CreateJobPipelineStepper view={pipeline} />
        </div>
      ) : null}

      {snapshot ? (
        <div
          className={cn(
            "space-y-2 transition-opacity duration-300",
            cancelling && "opacity-55",
          )}
        >
          <ProgressIndicator
            percent={snapshot.percent}
            label={snapshot.label}
            indeterminate={Boolean(snapshot.indeterminate)}
            hidePercent={Boolean(snapshot.hidePercent) || hideOverallBar}
            hideBar={hideOverallBar}
            metric={snapshot.metric}
            metricLabel={snapshot.metricLabel}
            legend={snapshot.legend}
            fileProgress={snapshot.fileProgress}
            tasks={showTasks ? view.tasks : undefined}
          />
          {snapshot.detail ? (
            <p className="text-xs tabular-nums text-muted" aria-live="polite">
              {snapshot.detail}
            </p>
          ) : null}
        </div>
      ) : showTasks ? (
        <div
          className={cn(
            "transition-opacity duration-300",
            cancelling && "opacity-55",
          )}
        >
          <ProgressIndicator
            percent={view.tasks[0]?.percent ?? 0}
            label={hideOverallBar ? undefined : view.encodeLabel}
            hideBar={hideOverallBar}
            hidePercent={hideOverallBar}
            tasks={view.tasks}
          />
        </div>
      ) : null}
    </section>
  );
}
