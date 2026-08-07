import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {available ? "Update verfügbar" : "Update-Prüfung"}
          </DialogTitle>
          <DialogDescription>
            {result?.message || "Update-Status wird geladen…"}
          </DialogDescription>
        </DialogHeader>

        {available && (
          <div className="space-y-2 text-sm">
            <p>
              Version <strong>{result?.latest_version}</strong> kann installiert werden.
              <br />
              Aktuell: {result?.current_version}
            </p>
            {result?.body ? (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs">
                {result.body}
              </pre>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
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
