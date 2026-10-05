import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, QrCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DialogActionRows } from "@/components/DialogActionRows";
import { QrSpotlightPreview } from "@/components/QrSpotlightPreview";
import { cn } from "@/lib/utils";
import type { QrPreview } from "@/lib/tauri";
import type {
  DialogActionStatus,
  DialogChoicesOptions,
  DialogConfirmOptions,
  DialogPromptOptions,
  DialogVariant,
} from "@/store/uiStore";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";

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
  /** QR hit-frame spotlight (right column when present). */
  qrPreview?: QrPreview | null;
  /** Dual-button confirm (e.g. QR customer switch). Dismiss = secondary. */
  confirm?: DialogConfirmOptions | null;
  /** Equal-weight choices (e.g. Handcam vs Outside). Dismiss = onCancel. */
  choices?: DialogChoicesOptions | null;
  /** Inline text/password prompt (e.g. AMS access code). */
  prompt?: DialogPromptOptions | null;
  onClose: () => void;
};

export function SuccessDialog({
  open,
  title,
  message,
  autoCloseSecs = null,
  variant = "default",
  highlight = "",
  actions = [],
  qrPreview = null,
  confirm = null,
  choices = null,
  prompt = null,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("dialogs.success.defaultTitle");
  const timeoutSecs =
    !confirm && !choices && !prompt && autoCloseSecs && autoCloseSecs > 0
      ? autoCloseSecs
      : null;
  const [remaining, setRemaining] = useState(timeoutSecs ?? 0);
  const [barActive, setBarActive] = useState(false);
  const [promptValue, setPromptValue] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const isQr = variant === "qr";
  const highlightText = highlight.trim();
  const hasActions = actions.length > 0;
  const hasError = actions.some((a) => a.tone === "error");
  const hasWarning =
    Boolean(confirm) ||
    Boolean(choices) ||
    Boolean(prompt) ||
    actions.some((a) => a.tone === "warning");
  const accent = hasError ? "warning" : hasWarning ? "warning" : "success";
  const messageText = message.trim();
  const hasPreview = Boolean(qrPreview?.path?.trim());

  useEffect(() => {
    if (!open) {
      setPromptValue("");
      setPromptBusy(false);
      return;
    }
    setPromptValue(prompt?.initialValue ?? "");
    setPromptBusy(false);
  }, [open, prompt?.initialValue]);

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
  }, [open, timeoutSecs, message, resolvedTitle, variant, highlightText, actions]);

  function dismissSafe() {
    if (closedRef.current || promptBusy) return;
    closedRef.current = true;
    const p = promptRef.current;
    if (p) {
      p.onCancel?.();
      onCloseRef.current();
      return;
    }
    const c = confirmRef.current;
    if (c) {
      c.onSecondary();
      return;
    }
    const ch = choicesRef.current;
    if (ch) {
      ch.onCancel();
      return;
    }
    onCloseRef.current();
  }

  function onPrimaryConfirm() {
    if (closedRef.current) return;
    closedRef.current = true;
    confirmRef.current?.onPrimary();
  }

  function onSecondaryConfirm() {
    if (closedRef.current) return;
    closedRef.current = true;
    confirmRef.current?.onSecondary();
  }

  function onChoicePick(id: string) {
    if (closedRef.current) return;
    closedRef.current = true;
    choicesRef.current?.onPick(id);
  }

  function onChoiceCancel() {
    if (closedRef.current) return;
    closedRef.current = true;
    choicesRef.current?.onCancel();
  }

  async function onPromptSubmit() {
    const p = promptRef.current;
    if (!p || promptBusy || closedRef.current) return;
    const value = promptValue.trim();
    if (!value) return;
    setPromptBusy(true);
    try {
      await p.onSubmit(value);
    } finally {
      setPromptBusy(false);
    }
  }

  function close() {
    dismissSafe();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className={cn(
          "z-[130] pb-7",
          // Keep viewport clamp when widening for QR preview (twMerge would drop the base max-w).
          hasPreview
            ? "max-w-[min(48rem,calc(100vw-2rem))]"
            : "max-w-[min(28rem,calc(100vw-2rem))]",
          accent === "success" && "border-l-4 border-l-success",
          accent === "warning" && "border-l-4 border-l-warning",
        )}
        overlayClassName="z-[130]"
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
                  {resolvedTitle}
                </DialogTitle>
              </div>
            </div>
          ) : (
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
              {resolvedTitle}
            </DialogTitle>
          )}
          {isQr && highlightText ? (
            <p
              className={cn(
                "min-w-0 break-words pt-1.5 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]",
                accent === "success" ? "text-primary" : "text-warning",
              )}
            >
              {highlightText}
            </p>
          ) : null}
          {!hasPreview && messageText && !hasActions ? (
            <DialogDescription className="whitespace-pre-wrap break-words text-foreground">
              {messageText}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {messageText || t("dialogs.success.actionsSummary")}
            </DialogDescription>
          )}
        </DialogHeader>

        <div
          className={cn(
            hasPreview && "grid gap-4 sm:grid-cols-2 sm:items-start",
          )}
        >
          <div className="min-w-0">
            {hasPreview && messageText && !hasActions ? (
              <p className="whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">
                {messageText}
              </p>
            ) : null}

            {hasActions ? <DialogActionRows actions={actions} /> : null}

            {messageText && hasActions ? (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted [overflow-wrap:anywhere]">
                {messageText}
              </p>
            ) : null}

            {prompt ? (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="success-dialog-prompt">{prompt.label}</Label>
                {prompt.password !== false ? (
                  <PasswordInput
                    id="success-dialog-prompt"
                    value={promptValue}
                    disabled={promptBusy}
                    autoFocus
                    autoComplete="off"
                    placeholder={prompt.placeholder}
                    onChange={(e) => setPromptValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void onPromptSubmit();
                      }
                    }}
                  />
                ) : (
                  <Input
                    id="success-dialog-prompt"
                    value={promptValue}
                    disabled={promptBusy}
                    autoFocus
                    autoComplete="off"
                    placeholder={prompt.placeholder}
                    onChange={(e) => setPromptValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void onPromptSubmit();
                      }
                    }}
                  />
                )}
              </div>
            ) : null}
          </div>

          {hasPreview && qrPreview ? (
            <QrSpotlightPreview preview={qrPreview} className="w-full" />
          ) : null}
        </div>

        <DialogFooter
          className={cn(
            "w-full min-w-0",
            choices && "flex-col sm:flex-col sm:items-stretch",
          )}
        >
          {choices ? (
            <>
              {choices.options.map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  className="h-auto min-h-9 w-full flex-col items-start gap-0.5 whitespace-normal py-2 text-left"
                  onClick={() => onChoicePick(opt.id)}
                >
                  <span>{opt.label}</span>
                  {opt.detail ? (
                    <span className="text-[11px] font-normal text-primary-foreground/80">
                      {opt.detail}
                    </span>
                  ) : null}
                </Button>
              ))}
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={onChoiceCancel}
              >
                {choices.cancelLabel ?? t("common.actions.cancel")}
              </Button>
            </>
          ) : prompt ? (
            <>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                disabled={promptBusy}
                onClick={close}
              >
                {prompt.cancelLabel ?? t("dialogs.update.later")}
              </Button>
              <Button
                type="button"
                className="shrink-0"
                disabled={promptBusy || !promptValue.trim()}
                onClick={() => void onPromptSubmit()}
              >
                {promptBusy
                  ? t("common.actions.checking")
                  : prompt.submitLabel}
              </Button>
            </>
          ) : confirm ? (
            <>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                onClick={onSecondaryConfirm}
              >
                {confirm.secondaryLabel}
              </Button>
              <Button
                type="button"
                className="shrink-0"
                onClick={onPrimaryConfirm}
              >
                {confirm.primaryLabel}
              </Button>
            </>
          ) : (
            <Button className="shrink-0" onClick={close}>
              {t("common.actions.ok")}
              {timeoutSecs && remaining > 0
                ? t("dialogs.countdownSuffix", { seconds: remaining })
                : ""}
            </Button>
          )}
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
            aria-label={t("dialogs.autoCloseAria")}
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
