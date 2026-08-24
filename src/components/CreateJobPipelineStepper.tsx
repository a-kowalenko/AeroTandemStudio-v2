import { AlertCircle, Check, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CreateJobPipelineView } from "@/lib/createJobPlan";

type Props = {
  view: CreateJobPipelineView;
  className?: string;
};

function stepChipClass(opts: {
  reached: boolean;
  current: boolean;
  failed: boolean;
}): string {
  if (opts.failed) {
    return "border-border/50 bg-muted/30 text-muted-foreground/60";
  }
  if (opts.current) {
    return "border-foreground/25 bg-foreground/10 font-medium text-foreground";
  }
  if (opts.reached) {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100";
  }
  return "border-border/50 bg-transparent text-muted-foreground/70";
}

/** Horizontal create-job step chips (AMS-handoff style, slightly larger). */
export function CreateJobPipelineStepper({ view, className }: Props) {
  const { t } = useTranslation();
  const { steps, activeIndex, completed, cancelled, failed } = view;

  const visibleSteps = cancelled
    ? steps
        .map((step, i) => ({ step, i }))
        .filter(({ i }) => i <= Math.max(activeIndex, 0))
    : steps.map((step, i) => ({ step, i }));

  return (
    <div className={cn("space-y-1", className)}>
      <ol
        className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5 text-[11px]"
        aria-label={t("workflow.createSteps.aria")}
      >
        {visibleSteps.map(({ step, i }, visibleIdx) => {
          const reached =
            !failed &&
            (completed ? i <= activeIndex : i < activeIndex);
          const current =
            !failed && !cancelled && !completed && i === activeIndex;
          return (
            <li key={step.id} className="flex items-center gap-0.5">
              {visibleIdx > 0 ? (
                <span
                  className={cn(
                    "mx-0.5 h-px w-2.5 shrink-0",
                    reached || current ? "bg-foreground/35" : "bg-border",
                  )}
                  aria-hidden
                />
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors duration-300",
                  stepChipClass({ reached, current, failed }),
                  current && "ams-chip-active",
                )}
                aria-current={current ? "step" : undefined}
              >
                {reached && !current ? (
                  <Check
                    className="size-3 shrink-0"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                ) : null}
                {current ? (
                  <Loader2
                    className="size-3 shrink-0 animate-spin [animation-duration:1.4s]"
                    aria-hidden
                  />
                ) : null}
                {t(step.labelKey)}
              </span>
            </li>
          );
        })}
        {failed || cancelled ? (
          <li className="flex items-center gap-0.5">
            <span
              className={cn(
                "mx-0.5 h-px w-2.5 shrink-0",
                cancelled ? "bg-amber-500/50" : "bg-destructive/50",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
                cancelled
                  ? "border-amber-500/45 bg-amber-500/10 text-amber-900 dark:text-amber-100"
                  : "border-destructive/50 bg-destructive/10 text-destructive",
              )}
            >
              {cancelled ? (
                <XCircle className="size-3 shrink-0" aria-hidden />
              ) : (
                <AlertCircle className="size-3 shrink-0" aria-hidden />
              )}
              {cancelled
                ? t("workflow.createSteps.cancelled")
                : t("workflow.createSteps.failed")}
            </span>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
