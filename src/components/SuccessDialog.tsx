import { useEffect, useRef, useState } from "react";
import { CheckCircle2, QrCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DialogVariant } from "@/store/uiStore";

type Props = {
  open: boolean;
  title?: string;
  message: string;
  /** When set, OK auto-confirms after this many seconds (countdown on the button). */
  autoCloseSecs?: number | null;
  variant?: DialogVariant;
  /** Prominent line under the title (e.g. customer name for QR). */
  highlight?: string;
  onClose: () => void;
};

export function SuccessDialog({
  open,
  title = "Erfolg",
  message,
  autoCloseSecs = null,
  variant = "default",
  highlight = "",
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
  }, [open, timeoutSecs, message, title, variant, highlightText]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-md border-l-4 border-l-success pb-7">
        <DialogHeader>
          {isQr ? (
            <div className="mb-1 flex items-center gap-2.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <QrCode className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                  {title}
                </DialogTitle>
              </div>
            </div>
          ) : (
            <DialogTitle className="text-success">{title}</DialogTitle>
          )}
          {isQr && highlightText ? (
            <p className="pt-1 text-xl font-semibold tracking-tight text-foreground">
              {highlightText}
            </p>
          ) : null}
          <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
            {message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button className="shrink-0" onClick={close}>
            OK{timeoutSecs && remaining > 0 ? ` (${remaining}s)` : ""}
          </Button>
        </DialogFooter>
        {timeoutSecs ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-success/15"
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
              className="h-full origin-left bg-success"
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
