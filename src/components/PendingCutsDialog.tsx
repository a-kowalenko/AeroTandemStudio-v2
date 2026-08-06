import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

type PendingCutsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summaries: string[];
  onRemoveAt: (index: number) => void;
  onClearAll: () => void;
  onApply: () => void;
  applying?: boolean;
};

export function PendingCutsDialog({
  open,
  onOpenChange,
  summaries,
  onRemoveAt,
  onClearAll,
  onApply,
  applying,
}: PendingCutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Ausstehende Schnitte</DialogTitle>
          <DialogDescription>
            Geplante Operationen (von oben nach unten nacheinander).
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-border/60 bg-card-elevated p-2 font-mono text-xs">
          {summaries.length === 0 ? (
            <li className="text-muted">Keine Einträge</li>
          ) : (
            summaries.map((line, i) => (
              <li
                key={`${line}-${i}`}
                className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-primary/5"
              >
                <span className="truncate">{line}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={applying}
                  onClick={() => onRemoveAt(i)}
                >
                  Entfernen
                </Button>
              </li>
            ))
          )}
        </ul>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={applying || summaries.length === 0}
            onClick={onClearAll}
          >
            Alle verwerfen
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Schließen
            </Button>
            <Button
              type="button"
              disabled={applying || summaries.length === 0}
              onClick={onApply}
            >
              Alle anwenden…
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
