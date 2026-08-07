import { useEffect, useRef, useState } from "react";
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
 * Shown when Intro+Body stream-copy fails. Default is without intro;
 * that option auto-selects after `timeoutSecs` (countdown on the button).
 */
export function IntroMuxFallbackDialog({
  open,
  reason,
  timeoutSecs = 15,
  onChoose,
}: Props) {
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
        className="border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("without_intro");
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-warning">
            Intro kann nicht per Stream-Copy angefügt werden
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-sm text-foreground">
              <p>
                Das Zusammenfügen von Intro und Video ohne Neu-Kodierung ist
                fehlgeschlagen (häufig bei modernen Kameradateien).
              </p>
              {reason ? (
                <p className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted">
                  {reason}
                </p>
              ) : null}
              <p className="text-muted">
                Bitte wählen: Video ohne Intro exportieren (schnell) oder mit Intro
                neu kodieren (dauert länger).
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => choose("with_intro_encode")}
          >
            Mit Intro (Encoding)
          </Button>
          <Button variant="default" onClick={() => choose("without_intro")}>
            Ohne Intro{remaining > 0 ? ` (${remaining}s)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
