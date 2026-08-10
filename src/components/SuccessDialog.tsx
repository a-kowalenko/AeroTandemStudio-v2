import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  Eraser,
  MinusCircle,
  QrCode,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  DialogActionKind,
  DialogActionStatus,
  DialogActionTone,
  DialogVariant,
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

type Props = {
  open: boolean;
  title?: string;
  message: string;
  /** When set, OK auto-confirms after this many seconds (countdown on the button). */
  autoCloseSecs?: number | null;
  variant?: DialogVariant;
  /** Prominent line under the title (e.g. customer name for QR). */
  highlight?: string;
  /** Per-action rows (QR, Backup, Import, Clear, Eject). */
  actions?: DialogActionStatus[];
  onClose: () => void;
};

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

function toneLabel(tone: DialogActionTone): string {
  switch (tone) {
    case "success":
      return "Erfolgreich";
    case "error":
      return "Fehlgeschlagen";
    case "warning":
      return "Hinweis";
    case "skipped":
      return "Übersprungen";
  }
}

function ActionRow({ action }: { action: DialogActionStatus }) {
  return (
    <li
      className={cn(
        "flex min-w-0 gap-2.5 rounded-md border px-3 py-2.5",
        action.tone === "error" && "border-destructive/40 bg-destructive/5",
        action.tone === "warning" && "border-warning/40 bg-warning/5",
        action.tone === "success" && "border-border/50 bg-muted/20",
        action.tone === "skipped" && "border-border/40 bg-muted/10 opacity-80",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          action.tone === "success" && "bg-success/15 text-success",
          action.tone === "error" && "bg-destructive/15 text-destructive",
          action.tone === "warning" && "bg-warning/15 text-warning",
          action.tone === "skipped" && "bg-muted text-muted",
        )}
        aria-hidden
      >
        {actionKindIcon(action.kind)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <p className="break-words text-sm font-medium text-foreground">
            {action.label}
          </p>
          <span className="flex shrink-0 items-center gap-1" title={toneLabel(action.tone)}>
            <span className="sr-only">{toneLabel(action.tone)}</span>
            {toneStatusIcon(action.tone)}
          </span>
        </div>
        <p className="mt-0.5 break-words text-sm text-foreground/90">
          {action.summary}
        </p>
        {action.detail?.trim() ? (
          <p
            className="mt-1 break-all text-xs text-muted [overflow-wrap:anywhere]"
            title={action.detail}
          >
            {action.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function SuccessDialog({
  open,
  title = "Erfolg",
  message,
  autoCloseSecs = null,
  variant = "default",
  highlight = "",
  actions = [],
  onClose,
}: Props) {
  const timeoutSecs = autoCloseSecs && autoCloseSecs > 0 ? autoCloseSecs : null;
  const [remaining, setRemaining] = useState(timeoutSecs ?? 0);
  const [barActive, setBarActive] = useState(false);
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isQr = variant === "qr";
  const highlightText = highlight.trim();
  const hasActions = actions.length > 0;
  const hasError = actions.some((a) => a.tone === "error");
  const hasWarning = actions.some((a) => a.tone === "warning");
  const accent = hasError ? "warning" : hasWarning ? "warning" : "success";
  const messageText = message.trim();

  useEffect(() => {
    if (!open || !timeoutSecs) {
      closedRef.current = false;
      setRemaining(timeoutSecs ?? 0);
      setBarActive(false);
      return;
    }

    closedRef.current = false;
    setRemaining(timeoutSecs);
    setBarActive(false);
    const startRaf = window.requestAnimationFrame(() => setBarActive(true));
    const started = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(
        0,
        timeoutSecs - Math.floor((Date.now() - started) / 1000),
      );
      setRemaining(left);
      if (left <= 0 && !closedRef.current) {
        closedRef.current = true;
        onCloseRef.current();
      }
    }, 250);
    return () => {
      window.cancelAnimationFrame(startRaf);
      window.clearInterval(id);
    };
  }, [open, timeoutSecs, message, title, variant, highlightText, actions]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className={cn(
          "max-w-md pb-7",
          accent === "success" && "border-l-4 border-l-success",
          accent === "warning" && "border-l-4 border-l-warning",
        )}
      >
        <DialogHeader>
          {isQr ? (
            <div className="mb-1 flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                  accent === "success"
                    ? "bg-success/15 text-success"
                    : "bg-warning/15 text-warning",
                )}
              >
                <QrCode className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle
                  className={cn(
                    "flex items-center gap-1.5",
                    accent === "success" ? "text-success" : "text-warning",
                  )}
                >
                  {accent === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                  ) : (
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                  )}
                  {title}
                </DialogTitle>
              </div>
            </div>
          ) : (
            <DialogTitle
              className={accent === "success" ? "text-success" : "text-warning"}
            >
              {title}
            </DialogTitle>
          )}
          {isQr && highlightText ? (
            <p className="pt-1 text-xl font-semibold tracking-tight text-foreground">
              {highlightText}
            </p>
          ) : null}
          {messageText && !hasActions ? (
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {messageText}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {messageText || "Zusammenfassung der Aktionen."}
            </DialogDescription>
          )}
        </DialogHeader>

        {hasActions ? (
          <ul className="min-w-0 space-y-2">
            {actions.map((action) => (
              <ActionRow
                key={`${action.kind}-${action.label}-${action.summary}`}
                action={action}
              />
            ))}
          </ul>
        ) : null}

        {messageText && hasActions ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted [overflow-wrap:anywhere]">
            {messageText}
          </p>
        ) : null}

        <DialogFooter>
          <Button className="shrink-0" onClick={close}>
            OK{timeoutSecs && remaining > 0 ? ` (${remaining}s)` : ""}
          </Button>
        </DialogFooter>
        {timeoutSecs ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden",
              accent === "success" ? "bg-success/15" : "bg-warning/15",
            )}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              barActive
                ? Math.round(((timeoutSecs - remaining) / timeoutSecs) * 100)
                : 0
            }
            aria-label="Automatisches Schließen"
          >
            <div
              className={cn(
                "h-full origin-left",
                accent === "success" ? "bg-success" : "bg-warning",
              )}
              style={{
                transform: barActive ? "scaleX(1)" : "scaleX(0)",
                transition: barActive
                  ? `transform ${timeoutSecs}s linear`
                  : "none",
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
