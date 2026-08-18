import {
  CheckCircle2,
  Clapperboard,
  Download,
  Eraser,
  Eye,
  FilePlus2,
  HardDrive,
  QrCode,
  Scissors,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ProgressIndicator } from "./ProgressIndicator";
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
  if (!view.visible) return null;

  const Icon = stageIcon(view.stage);
  const snapshot = view.snapshot;
  const showTasks =
    view.tasks.length > 0 &&
    (view.stage === "create" ||
      view.stage === "append" ||
      view.stage === "preview" ||
      view.stage === "cut");

  if (view.collapsed) {
    const label = snapshot?.label ?? view.encodeLabel;
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
      aria-label="Fortschritt"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              Fortschritt
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted">{view.subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view.canCancel && onCancel ? (
            <Button type="button" variant="destructive" size="sm" onClick={onCancel}>
              Abbrechen
            </Button>
          ) : null}
        </div>
      </div>

      {snapshot ? (
        <div className="space-y-2">
          <ProgressIndicator
            percent={snapshot.percent}
            label={snapshot.label}
            indeterminate={Boolean(snapshot.indeterminate)}
            hidePercent={Boolean(snapshot.hidePercent)}
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
        <ProgressIndicator
          percent={view.tasks[0]?.percent ?? 0}
          label={view.encodeLabel}
          tasks={view.tasks}
        />
      ) : null}
    </section>
  );
}
