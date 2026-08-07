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
import { ProgressIndicator } from "@/components/ProgressIndicator";
import { cn } from "@/lib/utils";
import type { UpdateCheckResult, UpdateInstallProgress } from "@/lib/tauri";

type Props = {
  open: boolean;
  result: UpdateCheckResult | null;
  installing?: boolean;
  installProgress?: UpdateInstallProgress | null;
  onInstall: () => void;
  onLater: () => void;
  onClose: () => void;
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

export function UpdateDialog({
  open,
  result,
  installing = false,
  installProgress = null,
  onInstall,
  onLater,
  onClose,
}: Props) {
  const available = Boolean(result?.available);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!open) setNotesOpen(false);
  }, [open]);

  const phase = installProgress?.phase ?? (installing ? "download" : null);
  const progressLabel =
    phase === "install"
      ? "Update wird installiert…"
      : phase === "download"
        ? "Update wird heruntergeladen…"
        : installing
          ? "Update wird vorbereitet…"
          : undefined;

  const detailParts: string[] = [];
  if (installProgress && phase === "download") {
    const done = formatBytes(installProgress.downloadedBytes);
    const total =
      installProgress.totalBytes != null && installProgress.totalBytes > 0
        ? formatBytes(installProgress.totalBytes)
        : null;
    detailParts.push(total ? `${done} / ${total}` : done);
    const speed = formatSpeed(installProgress.speedBps);
    if (speed) detailParts.push(speed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !installing) onClose();
      }}
    >
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>
            {available ? "Update verfügbar" : "Update-Prüfung"}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {result?.message || "Update-Status wird geladen…"}
          </DialogDescription>
        </DialogHeader>

        {available && (
          <div className="min-w-0 space-y-3 text-sm">
            <p className="min-w-0 break-words">
              Version <strong>{result?.latest_version}</strong> kann installiert werden.
              <br />
              Aktuell: {result?.current_version}
            </p>
            <div className="min-w-0 space-y-1.5">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                aria-expanded={notesOpen}
                disabled={installing}
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
                <div className="min-w-0 overflow-hidden border-l border-border/70 pl-3">
                  <pre className="max-h-48 max-w-full overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs leading-relaxed text-muted">
                    {result?.body?.trim() || "Keine Details verfügbar."}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {installing ? (
          <div className="min-w-0 space-y-2">
            <ProgressIndicator
              percent={
                installProgress?.percent ??
                (phase === "install" ? 100 : 0)
              }
              label={progressLabel}
            />
            {detailParts.length > 0 ? (
              <p className="text-xs tabular-nums text-muted">
                {detailParts.join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="min-w-0 gap-2">
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
