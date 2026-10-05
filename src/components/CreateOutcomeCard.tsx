import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, FolderOpen, Play, X } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePausableAutoDismiss } from "@/hooks/usePausableAutoDismiss";
import { SESSION_OUTCOME_EXIT_MS } from "@/lib/sessionRunOutcome";
import {
  CREATE_OUTCOME_HIDE_MS,
  buildCreateOutcomeRows,
  createOutcomeCustomerName,
  pathBasename,
  type CreateRunOutcome,
} from "@/lib/createRunOutcome";

type Props = {
  outcome: CreateRunOutcome;
  /** Inside the upload panel (above details) vs. own floating card. */
  variant: "embedded" | "standalone";
  /** 1-based waiting position when this job is not the active upload. */
  queuePosition?: number | null;
  onDone: () => void;
  className?: string;
};

/**
 * Non-modal create report (replaces the old success dialog). Hover pauses the
 * auto-hide; the timer survives moving between upload panel and standalone.
 */
export function CreateOutcomeCard({
  outcome,
  variant,
  queuePosition = null,
  onDone,
  className,
}: Props) {
  const { t } = useTranslation();
  const embedded = variant === "embedded";
  const info = outcome.info;
  const [exiting, setExiting] = useState(false);

  const uploadFinished = embedded && Boolean(info.serverUploaded);
  const { dismiss, hoverProps } = usePausableAutoDismiss(
    uploadFinished ? 0 : CREATE_OUTCOME_HIDE_MS,
    () => {
      if (embedded) {
        onDone();
        return;
      }
      setExiting(true);
      window.setTimeout(onDone, SESSION_OUTCOME_EXIT_MS);
    },
    `create-outcome-${outcome.id}`,
  );

  const rows = buildCreateOutcomeRows(info, t, { embedded });
  const warning = rows.some((r) => r.tone === "warning");
  const OutcomeIcon = warning ? AlertTriangle : CheckCircle2;
  const customerName = createOutcomeCustomerName(info);
  const outputDir = info.result.base_output_dir?.trim() ?? "";
  const videoPath = info.result.video_output?.trim() ?? "";

  async function openOutputDir() {
    if (!outputDir) return;
    try {
      await revealItemInDir(outputDir);
    } catch (e) {
      console.error("Speicherort öffnen fehlgeschlagen:", e);
    }
  }

  async function playVideo() {
    if (!videoPath) return;
    try {
      await openPath(videoPath);
    } catch (e) {
      console.error("Video abspielen fehlgeschlagen:", e);
    }
  }

  const actions = (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!outputDir}
        onClick={() => void openOutputDir()}
      >
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        {t("create.success.openLocation")}
      </Button>
      {videoPath ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="border-success/35 bg-success/10 text-success hover:bg-success/20"
          onClick={() => void playVideo()}
          title={pathBasename(videoPath)}
        >
          <Play className="h-3.5 w-3.5 shrink-0" />
          {t("create.success.play")}
        </Button>
      ) : null}
    </div>
  );

  if (embedded) {
    const photos = info.result.photos_copied;
    const bullets: string[] = [];
    if (videoPath) bullets.push(t("create.success.videoCreated"));
    if (photos > 0) {
      bullets.push(
        t(photos === 1 ? "create.success.photosCopied" : "create.success.photosCopiedMany", {
          count: photos,
        }),
      );
    }
    if (info.serverUploaded) bullets.push(t("create.success.uploaded"));
    return (
      <div
        className={className}
        role="status"
        aria-live="polite"
        aria-label={t("workflow.createOutcome.aria")}
        {...hoverProps}
      >
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
          <h2 className="text-sm font-semibold tracking-wide text-success uppercase">
            {t("create.success.title")}
          </h2>
          {queuePosition != null ? (
            <span className="text-[11px] text-muted">
              {t("create.success.queuePosition", { position: queuePosition })}
            </span>
          ) : null}
        </div>
        {customerName ? (
          <p className="mt-1 break-words text-lg font-semibold tracking-tight text-foreground">
            {customerName}
          </p>
        ) : null}
        {bullets.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {bullets.map((label) => (
              <li key={label} className="flex items-center gap-2 text-xs text-foreground">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        {actions}
      </div>
    );
  }

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeIcon
              className={cn(
                "h-4 w-4 shrink-0",
                warning ? "text-warning" : "text-success",
              )}
              aria-hidden
            />
            <h2
              className={cn(
                "text-sm font-semibold tracking-wide uppercase",
                warning ? "text-warning" : "text-success",
              )}
            >
              {t("create.success.title")}
            </h2>
            {queuePosition != null ? (
              <span className="text-[11px] text-muted">
                {t("create.success.queuePosition", { position: queuePosition })}
              </span>
            ) : null}
          </div>
          {customerName ? (
            <p className="mt-1 break-words text-lg font-semibold tracking-tight text-foreground">
              {customerName}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label={t("workflow.createOutcome.dismiss")}
          disabled={exiting}
          onClick={dismiss}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <ul className="mt-2 space-y-1">
        {rows.map((row) => (
          <li
            key={`${row.label}-${row.detail ?? ""}`}
            className="flex min-w-0 items-baseline gap-2 text-xs"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                row.tone === "warning" ? "bg-warning" : "bg-success",
              )}
              aria-hidden
            />
            <span className="shrink-0 font-medium text-foreground">{row.label}</span>
            {row.detail ? (
              <span className="min-w-0 truncate text-muted" title={row.detail}>
                {row.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {actions}
    </>
  );

  return (
    <section
      className={cn(
        "ats-surface relative pointer-events-auto overflow-hidden rounded-xl border p-4 shadow-lg backdrop-blur-md",
        exiting ? "ats-progress-float-out" : "ats-progress-float-in",
        warning ? "border-warning/50" : "border-border/80",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={t("workflow.createOutcome.aria")}
      {...hoverProps}
    >
      {body}
    </section>
  );
}
