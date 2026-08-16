import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type BodyConcatFallbackChoice = "abort" | "use_legacy";

type Props = {
  open: boolean;
  reason: string;
  onChoose: (choice: BodyConcatFallbackChoice) => void;
};

/**
 * Shown when Fast-Path clip concat fails.
 * User must abort or switch to Legacy — no auto-timeout.
 */
export function BodyConcatFallbackDialog({ open, reason, onChoose }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onChoose("abort");
      }}
    >
      <DialogContent
        className="max-w-lg overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onChoose("abort");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-warning">
            Fast Path fehlgeschlagen
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                Die Clips konnten nicht im schnellen Single-Pass
                zusammengefügt werden. Du kannst abbrechen oder den robusteren
                Legacy-Modus (MPEG-TS) verwenden — das dauert länger.
              </p>
              {reason ? (
                <p className="min-w-0 overflow-x-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted [overflow-wrap:anywhere]">
                  {reason}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onChoose("abort")}>
            Abbrechen
          </Button>
          <Button variant="default" onClick={() => onChoose("use_legacy")}>
            Legacy verwenden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
