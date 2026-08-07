import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
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
import type { UpdateCheckResult } from "@/lib/tauri";

type Props = {
  open: boolean;
  result: UpdateCheckResult | null;
  installing?: boolean;
  onInstall: () => void;
  onLater: () => void;
  onClose: () => void;
};

export function UpdateDialog({
  open,
  result,
  installing = false,
  onInstall,
  onLater,
  onClose,
}: Props) {
  const available = Boolean(result?.available);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!open) setNotesOpen(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {available ? "Update verfügbar" : "Update-Prüfung"}
          </DialogTitle>
          <DialogDescription>
            {result?.message || "Update-Status wird geladen…"}
          </DialogDescription>
        </DialogHeader>

        {available && (
          <div className="space-y-3 text-sm">
            <p>
              Version <strong>{result?.latest_version}</strong> kann installiert werden.
              <br />
              Aktuell: {result?.current_version}
            </p>
            <div className="space-y-1.5">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen((v) => !v)}
              >
                Patchnotes
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-200",
                    notesOpen && "rotate-180",
                  )}
                />
              </button>
              {notesOpen ? (
                <div className="border-l border-border/70 pl-3">
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
                    {result?.body?.trim() || "Keine Details verfügbar."}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {available ? (
            <>
              <Button type="button" variant="secondary" onClick={onLater} disabled={installing}>
                Später
              </Button>
              <Button type="button" onClick={onInstall} disabled={installing}>
                {installing ? "Installiere…" : "Jetzt aktualisieren"}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onClose}>
              OK
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
