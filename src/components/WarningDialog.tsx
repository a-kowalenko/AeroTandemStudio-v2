import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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
import { usePausableAutoDismiss } from "@/hooks/usePausableAutoDismiss";

type Props = {
  open: boolean;
  title?: string;
  message: string;
  /** Auto-dismiss after N seconds (null/0 = manual only). */
  autoCloseSecs?: number | null;
  onClose: () => void;
};

export function WarningDialog({
  open,
  title,
  message,
  autoCloseSecs = null,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("dialogs.warning.defaultTitle");
  const timeoutSecs =
    autoCloseSecs && autoCloseSecs > 0 ? autoCloseSecs : null;
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeRef = useRef<() => void>(() => {});

  const durationMs = open && timeoutSecs ? timeoutSecs * 1000 : 0;
  const { paused, remainingMs, remainingSec, hoverProps } =
    usePausableAutoDismiss(
      durationMs,
      () => closeRef.current(),
      undefined,
      `${resolvedTitle}\0${message}`,
    );

  useEffect(() => {
    if (open) closedRef.current = false;
  }, [open, resolvedTitle, message]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }
  closeRef.current = close;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="z-[130] max-w-md border-l-4 border-l-warning pb-7"
        overlayClassName="z-[130]"
        {...hoverProps}
      >
        <DialogHeader>
          <DialogTitle className="text-warning">{resolvedTitle}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
            {message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" className="shrink-0" onClick={close}>
            {t("common.actions.ok")}
            {timeoutSecs && remainingSec > 0
              ? t("dialogs.countdownSuffix", { seconds: remainingSec })
              : ""}
          </Button>
        </DialogFooter>
        {timeoutSecs && open ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-warning/15"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              durationMs > 0
                ? Math.round(((durationMs - remainingMs) / durationMs) * 100)
                : 0
            }
            aria-label={t("dialogs.autoCloseAria")}
          >
            <div
              key={`${resolvedTitle}\0${message}`}
              className={cn("h-full w-full origin-left bg-warning ats-toast-progress")}
              style={{
                animationDuration: `${durationMs}ms`,
                animationPlayState: paused ? "paused" : "running",
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
