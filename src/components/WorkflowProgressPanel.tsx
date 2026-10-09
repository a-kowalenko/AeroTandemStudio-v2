import {
  AlertTriangle,
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
import {
  cloneElement,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ProgressIndicator } from "./ProgressIndicator";
import { CreateJobPipelineStepper } from "./CreateJobPipelineStepper";
import { UploadJobHeader } from "./UploadJobHeader";
import { QrLiveScanStrip } from "./QrLiveScanStrip";
import { Button } from "./ui/button";
import { SessionOutcomeCard } from "./SessionOutcomeCard";
import { Spinner } from "./Spinner";
import { cn } from "../lib/utils";
import type { WorkflowProgressStage } from "../lib/workflowProgress";
import {
  formatUploadJobLine,
  type UploadQueueJobPreview,
} from "../lib/uploadQueue";
import type { WorkflowProgressView } from "../hooks/useWorkflowProgress";
import { usePausableAutoDismiss } from "../hooks/usePausableAutoDismiss";
import { CREATE_OUTCOME_HIDE_MS } from "../lib/createRunOutcome";
import { useQrScanStore } from "../store/qrScanStore";
import {
  bodyConcatModeLabelKey,
  bodyConcatModeShortLabelKey,
  bodyConcatModeToneClass,
} from "../lib/bodyConcatMode";
import type { BodyConcatMode } from "../lib/tauri";

type Props = {
  view: WorkflowProgressView;
  onCancel?: () => void;
  className?: string;
  /** Upload panel only: create report above the compact upload bar. */
  uploadOutcome?: ReactNode;
  /** Clears the finished-upload report when its timer ends. */
  onUploadDone?: () => void;
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
          {jobs.map((job) => {
            const line = formatUploadJobLine(job, t);
            return (
              <li
                key={job.id}
                className="truncate text-xs text-muted"
                title={line}
              >
                {line}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function BodyConcatModeBadge({
  mode,
  compact = false,
}: {
  mode: BodyConcatMode;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = t(
    compact
      ? bodyConcatModeShortLabelKey(mode)
      : bodyConcatModeLabelKey(mode),
  );
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-medium leading-tight",
        compact ? "text-[10px]" : "text-[11px]",
        bodyConcatModeToneClass(mode),
      )}
      title={t("workflow.bodyConcat.hint")}
      aria-label={t("workflow.bodyConcat.aria", { mode: label })}
    >
      {label}
    </span>
  );
}

function UploadCollapseButton({ view }: { view: WorkflowProgressView }) {
  const { t } = useTranslation();
  return (
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
  );
}

function CompactUploadBar({
  view,
  trailing,
}: {
  view: WorkflowProgressView;
  /** Right of % / size / speed (cancel, collapse, …). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const compact = view.uploadCompact;
  const pct = Math.round(compact.percent);
  const barWidth = view.uploadFailedHold
    ? Math.max(0, Math.min(100, compact.percent || view.snapshot?.percent || 0))
    : compact.percent > 0
      ? compact.percent
      : 8;
  const label = view.cancelling
    ? view.uploadCancelPhase === "cleanup"
      ? t("workflow.upload.cleaningUp")
      : t("common.actions.cancelling")
    : t("app.upload.title");
  const meta = [
    view.uploadFailedHold ? "—" : `${pct}%`,
    compact.bytesLabel,
    compact.speedLabel,
  ]
    .filter(Boolean)
    .join("  ");

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <p
          className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm font-medium text-foreground"
          title={label}
        >
          <Upload className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{label}</span>
          {view.uploadQueueCount > 0 ? (
            <span className="shrink-0 text-[11px] font-normal text-muted">
              {t("create.success.uploadQueued", {
                count: view.uploadQueueCount,
              })}
            </span>
          ) : null}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <p className="text-sm tabular-nums text-muted">{meta}</p>
          {view.uploadFailedHold ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              aria-label={t("common.actions.close")}
              onClick={view.onDismissFailedHold}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          {trailing}
        </div>
      </div>
      <div
        className="h-2.5 overflow-hidden rounded-full bg-border/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.uploadFailedHold ? undefined : pct}
        aria-label={label}
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
    </div>
  );
}

export function WorkflowProgressPanel({
  view,
  onCancel,
  className,
  uploadOutcome,
  onUploadDone,
}: Props) {
  const { t } = useTranslation();
  const qrLookup = useQrScanStore((s) => s.lookup);
  const { paused: donePaused, hoverProps: doneHover } = usePausableAutoDismiss(
    view.uploadDoneHold ? CREATE_OUTCOME_HIDE_MS : 0,
    () => onUploadDone?.(),
  );
  const {
    paused: failPaused,
    hoverProps: failHover,
    dismiss: dismissFailHold,
  } = usePausableAutoDismiss(
    view.uploadFailedHold ? CREATE_OUTCOME_HIDE_MS : 0,
    () => view.onDismissFailedHold(),
  );
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

  // Phase 37.2: create outcome or Nachholen header → stepper → upload bar.
  if (view.backgroundUpload) {
    const doneHold = view.uploadDoneHold;

    // Fail-hold: compact error card with red auto-hide bar.
    if (view.uploadFailedHold) {
      return (
        <section
          className={cn(
            "ats-surface relative pointer-events-auto overflow-hidden rounded-xl border border-destructive/40 p-4 pb-5 shadow-lg backdrop-blur-md ats-progress-float-in",
            className,
          )}
          aria-label={t("workflow.upload.failedHoldTitle")}
          role="status"
          aria-live="polite"
          {...failHover}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <h2 className="text-sm font-semibold tracking-wide text-destructive uppercase">
                  {t("workflow.upload.failedHoldTitle")}
                </h2>
              </div>
              <p className="mt-1 text-xs text-muted">
                {t("workflow.upload.failedHoldHint")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              aria-label={t("common.actions.close")}
              onClick={dismissFailHold}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-destructive/20"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("dialogs.autoCloseAria")}
          >
            <div
              className="h-full w-full origin-left bg-destructive ats-toast-progress"
              style={{
                animationDuration: `${CREATE_OUTCOME_HIDE_MS}ms`,
                animationPlayState: failPaused ? "paused" : "running",
              }}
            />
          </div>
        </section>
      );
    }

    const showCancel =
      Boolean(view.canCancel && onCancel) && !doneHold && !view.collapsed;
    const outcomeVisible = doneHold || !view.collapsed;
    const activeJob = view.uploadActiveJob;
    const showJobHeader =
      !uploadOutcome && !view.collapsed && Boolean(activeJob) && !doneHold;
    const cancelBtn = showCancel ? (
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
            {view.uploadCancelPhase === "cleanup"
              ? t("workflow.upload.cleaningUp")
              : t("common.actions.cancelling")}
          </>
        ) : (
          t("common.actions.cancel")
        )}
      </Button>
    ) : null;

    const outcomeNode =
      uploadOutcome && isValidElement(uploadOutcome)
        ? cloneElement(
            uploadOutcome as ReactElement<{
              headerEnd?: ReactNode;
              trailingControl?: ReactNode;
            }>,
            {
              headerEnd: cancelBtn,
              // While uploading: chevron on the right instead of dismiss X.
              trailingControl: doneHold ? undefined : (
                <UploadCollapseButton view={view} />
              ),
            },
          )
        : uploadOutcome;

    const hasUploadDetails = view.uploadQueueJobs.length > 0;
    const headerOwnsChrome = Boolean(outcomeNode && outcomeVisible) || showJobHeader;

    return (
      <section
        className={cn(
          "ats-surface relative pointer-events-auto overflow-hidden rounded-xl border border-border/80 p-4 shadow-lg backdrop-blur-md ats-progress-float-in",
          doneHold && "pb-3.5",
          className,
        )}
        aria-label={t("app.upload.title")}
        aria-busy={cancelling || undefined}
        {...(doneHold ? doneHover : {})}
      >
        {outcomeNode ? (
          <div
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
              outcomeVisible
                ? "grid-rows-[1fr] opacity-100 mb-3"
                : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="min-h-0 overflow-hidden">{outcomeNode}</div>
          </div>
        ) : null}

        {showJobHeader && activeJob ? (
          <div className="mb-3">
            <UploadJobHeader
              job={activeJob}
              headerEnd={cancelBtn}
              trailingControl={<UploadCollapseButton view={view} />}
            />
          </div>
        ) : null}

        {!headerOwnsChrome && !view.collapsed && subtitle ? (
          <p className="mb-3 text-xs text-muted" aria-live="polite">
            {subtitle}
          </p>
        ) : null}

        {pipeline && (doneHold || !view.collapsed) ? (
          <div
            className={cn(
              "mb-3 transition-opacity duration-300",
              cancelling && "opacity-55",
            )}
          >
            <CreateJobPipelineStepper view={pipeline} />
          </div>
        ) : null}

        {!doneHold ? (
          <div
            className={cn(
              "transition-opacity duration-300",
              cancelling && "opacity-55",
            )}
          >
            <CompactUploadBar
              view={view}
              trailing={
                headerOwnsChrome ? (
                  view.collapsed ? (
                    <UploadCollapseButton view={view} />
                  ) : null
                ) : (
                  <>
                    {cancelBtn}
                    <UploadCollapseButton view={view} />
                  </>
                )
              }
            />
            {hasUploadDetails && !view.collapsed ? (
              <div className="mt-2">
                <UploadQueueCollapsible jobs={view.uploadQueueJobs} />
              </div>
            ) : null}
          </div>
        ) : null}

        {doneHold ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-success/20"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("dialogs.autoCloseAria")}
          >
            <div
              className="h-full w-full origin-left bg-success ats-toast-progress"
              style={{
                animationDuration: `${CREATE_OUTCOME_HIDE_MS}ms`,
                animationPlayState: donePaused ? "paused" : "running",
              }}
            />
          </div>
        ) : null}
      </section>
    );
  }

  if (view.sessionOutcome) {
    return (
      <SessionOutcomeCard
        outcome={view.sessionOutcome}
        onDismiss={view.onDismissSessionOutcome}
        className={className}
      />
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
        {view.bodyConcatMode ? (
          <BodyConcatModeBadge mode={view.bodyConcatMode} compact />
        ) : null}
      </div>
    );
  }

  return (
    <section
      className={cn(
        "ats-surface pointer-events-auto overflow-hidden rounded-xl border border-border/80 p-4 shadow-lg backdrop-blur-md ats-progress-float-in",
        className,
      )}
      aria-label={t("workflow.progress")}
      aria-busy={cancelling || undefined}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              {t("workflow.progress")}
            </h2>
            {view.bodyConcatMode ? (
              <BodyConcatModeBadge mode={view.bodyConcatMode} />
            ) : null}
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
          <QrLiveScanStrip />
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
          {qrLookup ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5",
                qrLookup.phase === "error" &&
                  "border-destructive/40 bg-destructive/5",
                qrLookup.phase === "miss" && "border-warning/40 bg-warning/5",
                qrLookup.phase === "found" && "border-border/50 bg-muted/20",
                qrLookup.phase === "searching" &&
                  "border-border/50 bg-muted/20",
              )}
              aria-live="polite"
              aria-busy={qrLookup.phase === "searching" || undefined}
            >
              {qrLookup.phase === "searching" ? (
                <Spinner size={14} className="shrink-0 border-[1.5px]" />
              ) : qrLookup.phase === "found" ? (
                <CheckCircle2
                  className="h-3.5 w-3.5 shrink-0 text-success"
                  aria-hidden
                />
              ) : qrLookup.phase === "error" ? (
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
              ) : (
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0 text-warning"
                  aria-hidden
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="shrink-0 text-sm font-medium text-foreground">
                    {qrLookup.summary}
                  </p>
                  {qrLookup.idChips && qrLookup.idChips.length > 0
                    ? qrLookup.idChips.map((chip) => (
                        <span
                          key={`${chip.label}:${chip.value}`}
                          className="inline-flex max-w-full items-baseline gap-1 rounded-md border border-border/60 bg-card/80 px-2 py-0.5 text-[11px] leading-tight text-foreground"
                        >
                          <span className="shrink-0 font-medium text-muted">
                            {chip.label}
                          </span>
                          <span className="min-w-0 truncate font-semibold tabular-nums">
                            {chip.value}
                          </span>
                        </span>
                      ))
                    : null}
                </div>
                {qrLookup.highlight.trim() ? (
                  <p className="mt-0.5 text-xs text-muted">
                    {qrLookup.highlight}
                  </p>
                ) : null}
                {!qrLookup.idChips?.length &&
                (qrLookup.phase === "miss" || qrLookup.phase === "error") &&
                !qrLookup.highlight.trim() ? (
                  <p className="mt-0.5 text-xs text-muted">
                    {t("ams.status.unreachableHint")}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
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
