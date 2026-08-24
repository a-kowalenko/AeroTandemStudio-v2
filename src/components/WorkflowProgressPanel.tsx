import {
  CheckCircle2,
  Clapperboard,
  Download,
  Eraser,
  Eye,
  FilePlus2,
  HardDrive,
  Loader2,
  QrCode,
  Scissors,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProgressIndicator } from "./ProgressIndicator";
import { CreateJobPipelineStepper } from "./CreateJobPipelineStepper";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { WorkflowProgressStage } from "../lib/workflowProgress";
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
