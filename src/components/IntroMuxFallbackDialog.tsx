import { useEffect, useRef, useState } from "react";
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

export type IntroMuxFallbackChoice = "without_intro" | "with_intro_encode";

type Props = {
  open: boolean;
  reason: string;
  timeoutSecs?: number;
  onChoose: (choice: IntroMuxFallbackChoice) => void;
};

/**
 * Shown when Intro+Body stream-copy fails.
 * Default is without intro; that option auto-selects after `timeoutSecs`.
 */
export function IntroMuxFallbackDialog({
  open,
  reason,
  timeoutSecs = 15,
  onChoose,
}: Props) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(timeoutSecs);
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
      setRemaining(timeoutSecs);
      return;
    }

    chosenRef.current = false;
    setRemaining(timeoutSecs);
    const started = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(
        0,
        timeoutSecs - Math.floor((Date.now() - started) / 1000),
      );
      setRemaining(left);
      if (left <= 0 && !chosenRef.current) {
        chosenRef.current = true;
        onChooseRef.current("without_intro");
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [open, timeoutSecs]);

  function choose(choice: IntroMuxFallbackChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("without_intro");
      }}
    >
      <DialogContent
        className="max-w-lg overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("without_intro");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-warning">
            {t("dialogs.introMux.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t("dialogs.introMux.body")}</p>
              {reason ? (
                <p className="min-w-0 overflow-x-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted [overflow-wrap:anywhere]">
                  {reason}
                </p>
              ) : null}
              <p className="text-muted">{t("dialogs.introMux.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => choose("with_intro_encode")}
          >
            {t("dialogs.introMux.withIntroEncode")}
          </Button>
          <Button variant="default" onClick={() => choose("without_intro")}>
            {t("dialogs.introMux.withoutIntro")}
            {remaining > 0
              ? t("dialogs.countdownSuffix", { seconds: remaining })
              : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
