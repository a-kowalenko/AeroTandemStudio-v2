import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Cloud,
  Download,
  Eraser,
  MinusCircle,
  QrCode,
  Search,
  Server,
  XCircle,
} from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { QrPreview } from "@/lib/tauri";
import type {
  DialogActionKind,
  DialogActionStatus,
  DialogActionTone,
} from "@/store/uiStore";

/** Classic macOS / SF Symbol eject glyph (triangle over bar). */
function EjectIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 4.2 4.85 14.4A1.1 1.1 0 0 0 5.78 16h12.44a1.1 1.1 0 0 0 .93-1.6L12 4.2Z" />
      <rect x="5.25" y="17.6" width="13.5" height="2.35" rx="0.7" />
    </svg>
  );
}

function actionKindIcon(kind: DialogActionKind): ReactNode {
  const cls = "h-4 w-4 shrink-0";
  switch (kind) {
    case "qr":
      return <QrCode className={cls} aria-hidden />;
    case "backup":
      return <Archive className={cls} aria-hidden />;
    case "import":
      return <Download className={cls} aria-hidden />;
    case "clear":
      return <Eraser className={cls} aria-hidden />;
    case "eject":
      return <EjectIcon className={cls} />;
    case "server":
      return <Server className={cls} aria-hidden />;
    case "ams":
      return <Search className={cls} aria-hidden />;
    case "cloud":
      return <Cloud className={cls} aria-hidden />;
  }
}

function toneStatusIcon(tone: DialogActionTone): ReactNode {
  const cls = "h-4 w-4 shrink-0";
  switch (tone) {
    case "success":
      return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
    case "error":
      return <XCircle className={cn(cls, "text-destructive")} aria-hidden />;
    case "warning":
      return <AlertTriangle className={cn(cls, "text-warning")} aria-hidden />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-muted")} aria-hidden />;
  }
}

function toneLabelKey(tone: DialogActionTone): string {
  switch (tone) {
    case "success":
      return "dialogs.success.tone.success";
    case "error":
      return "dialogs.success.tone.error";
    case "warning":
      return "common.status.warning";
    case "skipped":
      return "dialogs.success.tone.skipped";
  }
}

/** Fits typical action-row height; must not grow the tile. */
function QrActionThumb({ preview }: { preview: QrPreview }) {
  const { t } = useTranslation();
  const spot = preview.spotlight;
  return (
    <div className="relative h-[4.25rem] w-[6.5rem] shrink-0 self-center overflow-hidden rounded-md border border-border/60 bg-black">
      <img
        src={convertFileSrc(preview.path)}
        alt={t("qr.spotlight.frameAlt")}
        className="h-full w-full object-cover"
        draggable={false}
      />
      {spot ? (
        <div
          className="pointer-events-none absolute rounded-[1px] border border-success"
          style={{
            left: `${spot.x * 100}%`,
            top: `${spot.y * 100}%`,
            width: `${spot.size * 100}%`,
            aspectRatio: "1",
          }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

function ActionRow({
  action,
  compact,
  qrPreview,
}: {
  action: DialogActionStatus;
  compact?: boolean;
  qrPreview?: QrPreview | null;
}) {
  const { t } = useTranslation();
  const toneText = t(toneLabelKey(action.tone));
  const showQrThumb =
    action.kind === "qr" && Boolean(qrPreview?.path?.trim());
  return (
    <li
      className={cn(
        "flex min-w-0 gap-2.5 rounded-md border",
        // Minimal vertical pad when QR thumb is present so it fills the tile.
        showQrThumb
          ? "px-2.5 py-0.5"
          : compact
            ? "px-2.5 py-1.5"
            : "px-3 py-2.5",
        action.tone === "error" && "border-destructive/40 bg-destructive/5",
        action.tone === "warning" && "border-warning/40 bg-warning/5",
        action.tone === "success" && "border-border/50 bg-muted/20",
        action.tone === "skipped" && "border-border/40 bg-muted/10 opacity-80",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex shrink-0 items-center justify-center rounded-full",
          compact || showQrThumb ? "h-7 w-7" : "h-8 w-8",
          action.tone === "success" && "bg-success/15 text-success",
          action.tone === "error" && "bg-destructive/15 text-destructive",
          action.tone === "warning" && "bg-warning/15 text-warning",
          action.tone === "skipped" && "bg-muted text-muted",
        )}
        aria-hidden
      >
        {actionKindIcon(action.kind)}
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="min-w-0 break-words text-sm font-medium text-foreground">
          {action.label}
        </p>
        <p className="mt-0.5 break-words text-sm text-foreground/90">
          {action.summary}
        </p>
        {action.detail?.trim() ? (
          <p
            className="mt-1 whitespace-pre-wrap break-words text-xs text-muted"
            title={action.detail}
          >
            {action.detail}
          </p>
        ) : null}
      </div>
      {showQrThumb && qrPreview ? <QrActionThumb preview={qrPreview} /> : null}
      <span
        className="mt-0.5 flex shrink-0 items-center gap-1 self-start"
        title={action.busy ? action.summary : toneText}
      >
        <span className="sr-only">
          {action.busy ? action.summary : toneText}
        </span>
        {action.busy ? (
          <Spinner size={16} className="border-[1.5px]" />
        ) : (
          toneStatusIcon(action.tone)
        )}
      </span>
    </li>
  );
}

export function DialogActionRows({
  actions,
  compact,
  className,
  qrPreview,
}: {
  actions: DialogActionStatus[];
  compact?: boolean;
  className?: string;
  /** Shown on the QR action row when present. */
  qrPreview?: QrPreview | null;
}) {
  if (actions.length === 0) return null;
  return (
    <ul className={cn("min-w-0 space-y-2", className)}>
      {actions.map((action) => (
        <ActionRow
          key={`${action.kind}-${action.label}-${action.summary}`}
          action={action}
          compact={compact}
          qrPreview={qrPreview}
        />
      ))}
    </ul>
  );
}
