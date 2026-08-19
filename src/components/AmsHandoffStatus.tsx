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
import { cn } from "@/lib/utils";
import {
  AMS_HANDOFF_STEPS,
  handoffChipClass,
  handoffStateHint,
  handoffStateLabel,
  handoffStepIndex,
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
        ? `${label} (Cache)`
        : label);

  const classes = cn(
    "inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors duration-300",
    handoffChipClass(view),
    view.offline && "border-dashed opacity-80",
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
        <span className="shrink-0 text-[9px] font-normal opacity-80">Cache</span>
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

/** Phase stepper as chip pipeline for AMS handoff (detail pane). */
export function AmsHandoffStepper({ view, className }: StepperProps) {
  const { t } = useTranslation();
  const cancelled = isAmsCancelled(view);
  const failed =
    !cancelled && (view.state === "rejected" || view.state === "failed");
  const stepIdx = handoffStepIndex(view.state);
  const hint = handoffStateHint(view);
  const done = isAmsHandoffTerminal(view.state) && view.state === "completed";

  return (
    <div className={cn("space-y-1.5", className)}>
      <AmsHandoffStatusChip view={view} />
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[10px]">
        {AMS_HANDOFF_STEPS.map((step, i) => {
          const reached =
            !failed &&
            !cancelled &&
            stepIdx >= 0 &&
            (done ? i <= stepIdx : i < stepIdx);
          const current =
            !failed && !cancelled && stepIdx >= 0 && i === stepIdx && !done;
          return (
            <li key={step.id} className="flex items-center gap-0.5">
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
                  "inline-flex items-center gap-0.5 rounded border px-1 py-0.5 transition-colors duration-300",
                  stepChipClass({ reached, current, failed: failed || cancelled }),
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
              className="mx-0.5 h-px w-2 shrink-0 bg-destructive/50"
              aria-hidden
            />
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded border px-1 py-0.5 font-medium",
                cancelled
                  ? "border-border/70 bg-muted/50 text-muted-foreground"
                  : "border-destructive/50 bg-destructive/10 text-destructive",
              )}
            >
              {cancelled ? (
                <XCircle className="size-2.5 shrink-0" aria-hidden />
              ) : (
                <AlertCircle className="size-2.5 shrink-0" aria-hidden />
              )}
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
