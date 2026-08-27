import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  Clock,
  CloudOff,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  AMS_HANDOFF_STEPS,
  handoffChipClass,
  handoffProgressStepIndex,
  handoffStateHint,
  handoffStateLabel,
  isAmsCancelled,
  isAmsHandoffActive,
  isAmsHandoffTerminal,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";

type ChipProps = {
  view: AmsHandoffView;
  className?: string;
  title?: string;
  /** Shorter labels for table cells. */
  compact?: boolean;
  /** Emit click (e.g. focus detail / expand error). */
  onClick?: (e: MouseEvent<HTMLButtonElement | HTMLSpanElement>) => void;
};

function StateIcon({
  view,
  className,
}: {
  view: AmsHandoffView;
  className?: string;
}) {
  const iconClass = cn("size-3 shrink-0", className);
  if (view.offline) {
    return <CloudOff className={iconClass} aria-hidden />;
  }
  if (isAmsCancelled(view)) {
    return <XCircle className={iconClass} aria-hidden />;
  }
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return <Clock className={cn(iconClass, "opacity-90")} aria-hidden />;
    case "accepted":
      return <Check className={cn(iconClass, "opacity-80")} aria-hidden />;
    case "queued":
      return (
        <Loader2
          className={cn(iconClass, "animate-spin [animation-duration:1.4s]")}
          aria-hidden
        />
      );
    case "uploading":
      return <Upload className={cn(iconClass, "animate-pulse")} aria-hidden />;
    case "completed":
      return <Check className={iconClass} strokeWidth={2.5} aria-hidden />;
    case "rejected":
    case "failed":
      return <AlertCircle className={iconClass} aria-hidden />;
    default:
      return <Clock className={iconClass} aria-hidden />;
  }
}

/** Compact AMS status chip for list / meta rows. */
export function AmsHandoffStatusChip({
  view,
  className,
  title,
  compact = false,
  onClick,
}: ChipProps) {
  const { t } = useTranslation();
  const label = handoffStateLabel(view, { compact });
  const hint = handoffStateHint(view);
  const active = isAmsHandoffActive(view) && !view.offline;
  const prevState = useRef(view.state);
  const [successFlash, setSuccessFlash] = useState(false);

  useEffect(() => {
    const next = view.state.trim().toLowerCase();
    const prev = prevState.current.trim().toLowerCase();
    if (prev === next) return;
    prevState.current = view.state;
    if (next === "completed") {
      setSuccessFlash(true);
      const t = window.setTimeout(() => setSuccessFlash(false), 520);
      return () => window.clearTimeout(t);
    }
    setSuccessFlash(false);
  }, [view.state]);

  const tip =
    title ??
    (hint
      ? `${label} — ${hint}`
      : view.offline
        ? tr("ams.handoff.cacheTooltip", { label })
        : label);

  const classes = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium leading-tight ring-1 ring-inset transition-colors duration-300",
    handoffChipClass(view),
    view.offline && "opacity-80 [ring-style:dashed]",
    active && "ams-chip-active",
    successFlash && "ams-chip-success-flash",
    onClick && "cursor-pointer hover:brightness-[1.03]",
    className,
  );

  const body = (
    <>
      <StateIcon view={view} />
      <span className="truncate">{label}</span>
      {view.offline ? (
        <span className="shrink-0 text-[9px] font-normal opacity-80">{t("ams.handoff.cache")}</span>
      ) : null}
      {view.archive && view.state.trim().toLowerCase() === "completed" ? (
        <Archive className="size-2.5 shrink-0 opacity-70" aria-hidden />
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={classes} title={tip} onClick={onClick}>
        {body}
      </button>
    );
  }

  return (
    <span className={classes} title={tip}>
      {body}
    </span>
  );
}

type StepperProps = {
  view: AmsHandoffView;
  className?: string;
};

function stepChipClass(opts: {
  reached: boolean;
  current: boolean;
  failed: boolean;
}): string {
  if (opts.failed) {
    return "bg-muted/30 text-muted-foreground/60 ring-border/50";
  }
  if (opts.current) {
    return "bg-foreground/10 font-medium text-foreground ring-foreground/25";
  }
  if (opts.reached) {
    return "bg-emerald-500/12 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100";
  }
  return "bg-transparent text-muted-foreground/70 ring-border/50";
}

/** Phase stepper as chip pipeline for AMS handoff (detail pane). */
export function AmsHandoffStepper({ view, className }: StepperProps) {
  const { t } = useTranslation();
  const cancelled = isAmsCancelled(view);
  const failed =
    !cancelled && (view.state === "rejected" || view.state === "failed");
  const stepIdx = handoffProgressStepIndex(view);
  const hint = handoffStateHint(view);
  const done =
    !cancelled &&
    !failed &&
    isAmsHandoffTerminal(view.state) &&
    view.state === "completed";

  // On cancel: only show steps already completed, then Abgebrochen
  // (hide unfinished Upload / Fertig so the outcome follows the last reach).
  const visibleSteps = (
    cancelled
      ? AMS_HANDOFF_STEPS.map((step, i) => ({ step, i })).filter(
          ({ i }) => i <= Math.max(stepIdx - 1, 0),
        )
      : AMS_HANDOFF_STEPS.map((step, i) => ({ step, i }))
  );

  return (
    <div className={cn("space-y-1.5", className)}>
      <AmsHandoffStatusChip view={view} />
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[10px]">
        {visibleSteps.map(({ step, i }, visibleIdx) => {
          const reached =
            !failed &&
            stepIdx >= 0 &&
            (done ? i <= stepIdx : i < stepIdx);
          const current =
            !failed && !cancelled && stepIdx >= 0 && i === stepIdx && !done;
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
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 leading-tight ring-1 ring-inset transition-colors duration-300",
                  stepChipClass({ reached, current, failed }),
                  current && isAmsHandoffActive(view) && "ams-chip-active",
                )}
              >
                {reached && !current ? (
                  <Check className="size-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
                ) : null}
                {current && view.state.trim().toLowerCase() === "uploading" ? (
                  <Upload className="size-2.5 shrink-0 animate-pulse" aria-hidden />
                ) : null}
                {current &&
                (view.state.trim().toLowerCase() === "queued" ||
                  view.state.trim().toLowerCase() === "pending" ||
                  view.state.trim().toLowerCase() === "") ? (
                  <Loader2
                    className="size-2.5 shrink-0 animate-spin [animation-duration:1.4s]"
                    aria-hidden
                  />
                ) : null}
                {t(step.label)}
              </span>
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
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium leading-tight ring-1 ring-inset",
                cancelled
                  ? "bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100"
                  : "bg-destructive/10 text-destructive ring-destructive/35",
              )}
            >
              {cancelled ? (
                <XCircle className="size-2.5 shrink-0" aria-hidden />
              ) : (
                <AlertCircle className="size-2.5 shrink-0" aria-hidden />
              )}
              {cancelled
                ? t("ams.handoff.state.cancelled")
                : handoffStateLabel(view)}
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
