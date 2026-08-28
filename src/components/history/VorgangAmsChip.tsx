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
import {
  isAmsCancelled,
  isAmsHandoffActive,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { amsHandoffChipTone } from "./historyChipTones";
import { amsStateHint, amsStateLabel } from "./historyStatusLabels";

type Props = {
  view: AmsHandoffView;
  className?: string;
  title?: string;
  /** Shorter labels for table cells. */
  compact?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement | HTMLSpanElement>) => void;
};

function StateIcon({
  view,
}: {
  view: AmsHandoffView;
}) {
  if (view.offline) {
    return <CloudOff className="size-3 shrink-0" aria-hidden />;
  }
  if (isAmsCancelled(view)) {
    return <XCircle className="size-3 shrink-0" aria-hidden />;
  }
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return (
        <Clock className="size-3 shrink-0 opacity-90" aria-hidden />
      );
    case "accepted":
      return (
        <Check className="size-3 shrink-0 opacity-80" aria-hidden />
      );
    case "queued":
      return (
        <Loader2
          className="size-3 shrink-0 animate-spin [animation-duration:1.4s]"
          aria-hidden
        />
      );
    case "uploading":
      return (
        <Upload className="size-3 shrink-0 animate-pulse" aria-hidden />
      );
    case "completed":
      return (
        <Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
      );
    case "rejected":
    case "failed":
      return <AlertCircle className="size-3 shrink-0" aria-hidden />;
    default:
      return <Clock className="size-3 shrink-0" aria-hidden />;
  }
}

/** Compact AMS status chip for Vorgänge list / meta rows. */
export function VorgangAmsChip({
  view,
  className,
  title,
  compact = false,
  onClick,
}: Props) {
  const { t } = useTranslation();
  const label = amsStateLabel(view, { compact });
  const hint = amsStateHint(view);
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
      const timer = window.setTimeout(() => setSuccessFlash(false), 520);
      return () => window.clearTimeout(timer);
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

  const trailing = (
    <>
      {view.offline ? (
        <span className="shrink-0 text-[9px] font-normal opacity-80">
          {t("ams.handoff.cache")}
        </span>
      ) : null}
      {view.archive && view.state.trim().toLowerCase() === "completed" ? (
        <Archive className="size-2.5 shrink-0 opacity-70" aria-hidden />
      ) : null}
    </>
  );

  return (
    <HistoryStatusChip
      label={label}
      icon={<StateIcon view={view} />}
      toneClassName={amsHandoffChipTone(view)}
      title={tip}
      active={active}
      successFlash={successFlash}
      offline={view.offline}
      onClick={onClick}
      className={className}
      trailing={trailing}
    />
  );
}
