import { cn } from "@/lib/utils";
import {
  AMS_HANDOFF_STEPS,
  handoffChipClass,
  handoffStateHint,
  handoffStateLabel,
  handoffStepIndex,
  isAmsCancelled,
  isAmsHandoffTerminal,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";

type ChipProps = {
  view: AmsHandoffView;
  className?: string;
  title?: string;
};

/** Compact AMS status chip for list / meta rows. */
export function AmsHandoffStatusChip({ view, className, title }: ChipProps) {
  const label = handoffStateLabel(view);
  const hint = handoffStateHint(view);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        handoffChipClass(view),
        className,
      )}
      title={title ?? (hint ? `${label} — ${hint}` : label)}
    >
      {label}
    </span>
  );
}

type StepperProps = {
  view: AmsHandoffView;
  className?: string;
};

/** Simple phase stepper for AMS handoff (detail pane). */
export function AmsHandoffStepper({ view, className }: StepperProps) {
  const cancelled = isAmsCancelled(view);
  const failed =
    !cancelled &&
    (view.state === "rejected" || view.state === "failed");
  const stepIdx = handoffStepIndex(view.state);
  const hint = handoffStateHint(view);
  const done = isAmsHandoffTerminal(view.state) && view.state === "completed";

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <AmsHandoffStatusChip view={view} />
        {view.offline ? (
          <span className="text-[10px] text-muted-foreground">offline</span>
        ) : null}
      </div>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[10px]">
        {AMS_HANDOFF_STEPS.map((step, i) => {
          const reached =
            !failed &&
            !cancelled &&
            stepIdx >= 0 &&
            (done ? i <= stepIdx : i < stepIdx);
          const current =
            !failed && !cancelled && stepIdx >= 0 && i === stepIdx && !done;
          return (
            <li key={step.id} className="flex items-center gap-1">
              {i > 0 ? (
                <span
                  className={cn(
                    "mx-0.5 h-px w-2 shrink-0",
                    reached || current ? "bg-foreground/35" : "bg-border",
                  )}
                  aria-hidden
                />
              ) : null}
              <span
                className={cn(
                  "rounded px-1 py-0.5",
                  current && "bg-foreground/10 font-medium text-foreground",
                  reached && !current && "text-foreground/80",
                  !reached && !current && "text-muted-foreground/70",
                  (failed || cancelled) && i > 0 && "opacity-50",
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
        {failed || cancelled ? (
          <li className="flex items-center gap-1">
            <span className="mx-0.5 h-px w-2 shrink-0 bg-destructive/50" aria-hidden />
            <span className="rounded px-1 py-0.5 font-medium text-destructive">
              {cancelled ? "Abgebrochen" : handoffStateLabel(view)}
            </span>
          </li>
        ) : null}
      </ol>
      {hint ? (
        <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
