import {
  AlertCircle,
  Check,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  handoffProgressStepIndex,
  isAmsCancelled,
  isAmsHandoffActive,
  isAmsHandoffTerminal,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { stepperStepTone, stepperTerminalTone } from "./historyChipTones";
import {
  amsStateHint,
  amsStateLabel,
  amsStepLabel,
  HISTORY_AMS_STEPS,
} from "./historyStatusLabels";
import { VorgangAmsChip } from "./VorgangAmsChip";

type Props = {
  view: AmsHandoffView;
  className?: string;
};

/** Phase stepper as chip pipeline for AMS handoff (Vorgänge detail pane). */
export function VorgangAmsStepper({ view, className }: Props) {
  const cancelled = isAmsCancelled(view);
  const failed =
    !cancelled && (view.state === "rejected" || view.state === "failed");
  const stepIdx = handoffProgressStepIndex(view);
  const hint = amsStateHint(view);
  const done =
    !cancelled &&
    !failed &&
    isAmsHandoffTerminal(view.state) &&
    view.state === "completed";

  const visibleSteps = (
    cancelled
      ? HISTORY_AMS_STEPS.map((step, i) => ({ step, i })).filter(
          ({ i }) => i <= Math.max(stepIdx - 1, 0),
        )
      : HISTORY_AMS_STEPS.map((step, i) => ({ step, i }))
  );

  return (
    <div className={cn("space-y-1.5", className)}>
      <VorgangAmsChip view={view} />
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[10px]">
        {visibleSteps.map(({ step, i }, visibleIdx) => {
          const reached =
            !failed && stepIdx >= 0 && (done ? i <= stepIdx : i < stepIdx);
          const current =
            !failed && !cancelled && stepIdx >= 0 && i === stepIdx && !done;

          const stepIcon = reached && !current ? (
            <Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
          ) : current &&
            view.state.trim().toLowerCase() === "uploading" ? (
            <Upload className="size-3 shrink-0 animate-pulse" aria-hidden />
          ) : current &&
            (view.state.trim().toLowerCase() === "queued" ||
              view.state.trim().toLowerCase() === "pending" ||
              view.state.trim().toLowerCase() === "") ? (
            <Loader2
              className="size-3 shrink-0 animate-spin [animation-duration:1.4s]"
              aria-hidden
            />
          ) : undefined;

          return (
            <li key={step.id} className="flex items-center gap-0.5">
              {visibleIdx > 0 ? (
                <span
                  className={cn(
                    "mx-0.5 h-px w-2 shrink-0",
                    reached || current ? "bg-foreground/35" : "bg-border",
                  )}
                  aria-hidden
                />
              ) : null}
              <HistoryStatusChip
                variant="stepper"
                label={amsStepLabel(step.id)}
                icon={stepIcon}
                toneClassName={stepperStepTone({ reached, current, failed })}
                active={current && isAmsHandoffActive(view)}
                className="px-1.5"
              />
            </li>
          );
        })}
        {failed || cancelled ? (
          <li className="flex items-center gap-0.5">
            <span
              className={cn(
                "mx-0.5 h-px w-2 shrink-0",
                cancelled ? "bg-amber-500/50" : "bg-destructive/50",
              )}
              aria-hidden
            />
            <HistoryStatusChip
              variant="stepper"
              label={amsStateLabel(view)}
              icon={
                cancelled ? (
                  <XCircle className="size-3 shrink-0" aria-hidden />
                ) : (
                  <AlertCircle className="size-3 shrink-0" aria-hidden />
                )
              }
              toneClassName={stepperTerminalTone(cancelled)}
              className="px-1.5 font-medium"
            />
          </li>
        ) : null}
      </ol>
      {hint ? (
        <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
