import { CheckCircle2, FolderOpen, Play } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { CreateJobResult } from "@/lib/tauri";

export type CreateSuccessInfo = {
  result: CreateJobResult;
  /** True when upload ran and completed successfully. */
  serverUploaded?: boolean;
  /** Optional short note (success path or failure hint). */
  uploadNote?: string | null;
  vorname?: string | null;
  nachname?: string | null;
};

type Props = {
  open: boolean;
  info: CreateSuccessInfo | null;
  onClose: () => void;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

type Row = { label: string; detail?: string };

function buildRows(info: CreateSuccessInfo): Row[] {
  const { result, serverUploaded, uploadNote } = info;
  const rows: Row[] = [];

  if (result.video_output) {
    rows.push({
      label: result.reused_preview
        ? "Video aus Vorschau übernommen"
        : "Video erstellt",
      detail: basename(result.video_output),
    });
  }
  if (result.watermark_video) {
    rows.push({
      label: "Vorschau-Video erstellt",
      detail: basename(result.watermark_video),
    });
  }
  if (result.photos_copied > 0) {
    const n = result.photos_copied;
    rows.push({
      label: `${n} Foto${n === 1 ? "" : "s"} kopiert`,
    });
  }
  if (result.watermark_photos > 0) {
    const n = result.watermark_photos;
    rows.push({
      label: `${n} Vorschau-Foto${n === 1 ? "" : "s"} erstellt`,
    });
  }
  if (serverUploaded) {
    rows.push({
      label: "Auf Server hochgeladen",
      detail: uploadNote?.trim() || undefined,
    });
  } else if (uploadNote?.trim()) {
    rows.push({ label: uploadNote.trim() });
  }
  if (result.encoder) {
    rows.push({ label: "Encoder", detail: result.encoder });
  }
  if (rows.length === 0) {
    rows.push({ label: "Verzeichnis wurde erstellt" });
  }
  return rows;
}

export function CreateSuccessDialog({ open, info, onClose }: Props) {
  const outputDir = info?.result.base_output_dir?.trim() ?? "";
  const videoPath = info?.result.video_output?.trim() ?? "";
  const rows = info ? buildRows(info) : [];
  const customerName = [info?.vorname, info?.nachname]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");

  async function openOutputDir() {
    if (!outputDir) return;
    try {
      await revealItemInDir(outputDir);
    } catch (e) {
      console.error("Speicherort öffnen fehlgeschlagen:", e);
    }
  }

  async function playVideo() {
    if (!videoPath) return;
    try {
      await openPath(videoPath);
    } catch (e) {
      console.error("Video abspielen fehlgeschlagen:", e);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))] border-l-4 border-l-success gap-5">
        <DialogHeader className="min-w-0 space-y-3 pr-6">
          <div className="flex min-w-0 items-center gap-3">
            <CheckCircle2 className="h-8 w-8 shrink-0 text-success" aria-hidden />
            <DialogTitle className="min-w-0 break-words text-success">
              Erfolgreich erstellt
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Zusammenfassung der erstellten Dateien und Ordner.
          </DialogDescription>
        </DialogHeader>

        {info && (
          <div className="min-w-0 space-y-3">
            {customerName && (
              <p className="break-words text-center text-lg font-semibold tracking-tight text-foreground">
                {customerName}
              </p>
            )}

            <div className="min-w-0 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <p className="text-xs font-medium text-muted">Ordner</p>
              <p
                className="break-all text-sm text-foreground [overflow-wrap:anywhere]"
                title={outputDir}
              >
                {basename(outputDir) || outputDir || "—"}
              </p>
              {outputDir && basename(outputDir) !== outputDir && (
                <p className="mt-1 break-all text-[11px] text-muted [overflow-wrap:anywhere]">
                  {outputDir}
                </p>
              )}
            </div>

            <ul className="min-w-0 space-y-2">
              {rows.map((row) => (
                <li
                  key={`${row.label}-${row.detail ?? ""}`}
                  className="flex min-w-0 gap-2 rounded-md border border-border/50 px-3 py-2"
                >
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-foreground">
                      {row.label}
                    </p>
                    {row.detail && (
                      <p
                        className="break-all text-xs text-muted [overflow-wrap:anywhere]"
                        title={row.detail}
                      >
                        {row.detail}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={!outputDir}
              onClick={() => void openOutputDir()}
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              Zum Speicherort
            </Button>
            {videoPath && (
              <Button
                type="button"
                variant="secondary"
                className="w-full border-success/35 bg-success/10 text-success hover:bg-success/20 sm:w-auto"
                onClick={() => void playVideo()}
                title={basename(videoPath)}
              >
                <Play className="h-4 w-4 shrink-0" />
                Abspielen
              </Button>
            )}
          </div>
          <Button type="button" className="w-full sm:w-auto" onClick={onClose}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
