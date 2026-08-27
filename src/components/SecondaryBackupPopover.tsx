import { Loader2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { UploadCompactParts } from "@/lib/uploadProgress";
import { cn } from "@/lib/utils";

export type SecondaryBackupPopoverProps = {
  open: boolean;
  /** Anchor: popover renders below this wrapper (parent is relative). */
  compact: UploadCompactParts;
  state: string;
  filesLabel: string | null;
  message: string | null;
  /** Parallel Vorgang upload is also running (informational only). */
  parallelUploadPercent: number | null;
  cancelling: boolean;
  onCancelRequest: () => void;
  onDismiss: () => void;
};

/**
 * Detail panel under the header Server-Backup chip (Compact-Bar parity).
 * Independent of the Vorgang upload Compact-Bar.
 */
export function SecondaryBackupPopover({
  open,
  compact,
  state,
  filesLabel,
  message,
  parallelUploadPercent,
  cancelling,
  onCancelRequest,
  onDismiss,
}: SecondaryBackupPopoverProps) {
  const { t } = useTranslation();
  if (!open) return null;

  const active = state === "started" || state === "progress";
  const failed = state === "failed";
  const cancelled = state === "cancelled";
  const done = state === "done";
  const pct = Math.round(compact.percent);
  const barWidth = failed || cancelled
    ? Math.max(0, Math.min(100, compact.percent))
    : compact.percent > 0
      ? compact.percent
      : active
        ? 8
        : done
          ? 100
          : 0;

  return (
    <div
      role="dialog"
      aria-label={t("header.connection.chipServerBackup")}
      className={cn(
        "absolute top-full left-0 z-50 mt-1.5 w-[min(20rem,calc(100vw-1.5rem))]",
        "rounded-xl border border-border/80 bg-card/95 p-3 shadow-lg backdrop-blur-md",
        "ats-progress-float-in",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Upload className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="shrink-0 text-sm font-medium text-foreground">
          {t("header.connection.chipServerBackup")}
        </span>

        <div
          className="h-2 min-w-[4.5rem] flex-1 overflow-hidden rounded-full bg-border/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={active || done ? pct : undefined}
          aria-label={t("header.connection.chipServerBackup")}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out",
              failed
                ? "bg-destructive/80"
                : cancelled
                  ? "bg-muted"
                  : "bg-[linear-gradient(90deg,var(--ats-progress-from),var(--ats-progress-to))]",
            )}
            style={{
              width: `${barWidth}%`,
              opacity: compact.percent > 0 || done || failed || cancelled ? 1 : 0.55,
            }}
          />
        </div>

        <span className="shrink-0 text-xs tabular-nums text-muted">
          {failed || cancelled ? "—" : `${pct}%`}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted">
        {compact.bytesLabel ? <span>{compact.bytesLabel}</span> : null}
        {compact.speedLabel && active ? <span>{compact.speedLabel}</span> : null}
        {filesLabel ? <span>{filesLabel}</span> : null}
      </div>

      {failed && message?.trim() ? (
        <p className="mt-2 text-xs leading-snug text-destructive break-words">
          {message.trim()}
        </p>
      ) : null}

      {cancelled ? (
        <p className="mt-2 text-xs leading-snug text-muted">
          {t("header.backupPopover.cancelledLocalRemains")}
        </p>
      ) : null}

      {done ? (
        <p className="mt-2 text-xs leading-snug text-success">
          {t("header.connection.chipServerBackupDone")}
        </p>
      ) : null}

      {parallelUploadPercent != null ? (
        <p className="mt-2 text-[11px] text-muted">
          {t("header.connection.parallelUpload", {
            percent: Math.round(parallelUploadPercent),
          })}
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center justify-end gap-1">
        {failed || cancelled || done ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            aria-label={t("common.actions.close")}
            onClick={onDismiss}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}

        {active ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={cancelling}
            aria-busy={cancelling || undefined}
            onClick={onCancelRequest}
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
  );
}
