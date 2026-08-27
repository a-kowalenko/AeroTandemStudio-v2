import { CheckCircle2, FolderOpen, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { formatBytes } from "@/lib/formatBytes";
import { useServerStore } from "@/store/serverStore";
import { useUploadQueueStore } from "@/store/uploadQueueStore";

export type CreateSuccessInfo = {
  result: CreateJobResult;
  /** True when upload ran and completed successfully. */
  serverUploaded?: boolean;
  /** True when upload was skipped because the server was offline (pending). */
  uploadDeferred?: boolean;
  /** Background upload enqueued / running (Phase 37.1). */
  uploadInProgress?: boolean;
  /** Slot job id for live progress matching. */
  uploadJobId?: string | null;
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

export function CreateSuccessDialog({ open, info, onClose }: Props) {
  const { t } = useTranslation();
  const outputDir = info?.result.base_output_dir?.trim() ?? "";
  const videoPath = info?.result.video_output?.trim() ?? "";
  const customerName = [info?.vorname, info?.nachname]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");

  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const activeUploadId = useUploadQueueStore((s) => s.active?.id ?? null);
  const queuedCount = useUploadQueueStore((s) => s.queue.length);

  const liveUpload =
    Boolean(info?.uploadInProgress) &&
    Boolean(info?.uploadJobId) &&
    activeUploadId === info?.uploadJobId;

  const livePercent = liveUpload
    ? Math.max(0, Math.min(100, uploadProgress?.percent ?? 0))
    : 0;
  const liveBytes =
    liveUpload && uploadProgress && uploadProgress.total_bytes > 0
      ? t("app.upload.bytesProgress", {
          current: formatBytes(uploadProgress.current_bytes),
          total: formatBytes(uploadProgress.total_bytes),
        })
      : null;

  function buildRows(current: CreateSuccessInfo): Row[] {
    const {
      result,
      serverUploaded,
      uploadDeferred,
      uploadInProgress,
      uploadNote,
    } = current;
    const rows: Row[] = [];

    if (result.video_output) {
      rows.push({
        label: result.reused_preview
          ? t("create.success.videoFromPreview")
          : t("create.success.videoCreated"),
        detail: basename(result.video_output),
      });
    }
    if (result.watermark_video) {
      rows.push({
        label: t("create.success.previewVideo"),
        detail: basename(result.watermark_video),
      });
    }
    if (result.photos_copied > 0) {
      const n = result.photos_copied;
      rows.push({
        label: t(n === 1 ? "create.success.photosCopied" : "create.success.photosCopiedMany", {
          count: n,
        }),
      });
    }
    if (result.watermark_photos > 0) {
      const n = result.watermark_photos;
      rows.push({
        label: t(
          n === 1 ? "create.success.previewPhotos" : "create.success.previewPhotosMany",
          { count: n },
        ),
      });
    }
    if (uploadInProgress) {
      rows.push({
        label: t("create.success.uploadRunning"),
        detail: uploadNote?.trim() || undefined,
      });
    } else if (serverUploaded) {
      rows.push({
        label: t("create.success.uploaded"),
        detail: uploadNote?.trim() || undefined,
      });
    } else if (uploadDeferred) {
      rows.push({
        label: t("create.success.uploadPending"),
        detail: uploadNote?.trim() || t("create.success.uploadPendingHint"),
      });
    } else if (uploadNote?.trim()) {
      rows.push({ label: uploadNote.trim() });
    }
    if (result.encoder) {
      rows.push({ label: t("create.success.encoder"), detail: result.encoder });
    }
    if (rows.length === 0) {
      rows.push({ label: t("create.success.dirCreated") });
    }
    return rows;
  }

  const rows = info ? buildRows(info) : [];

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
              {t("create.success.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t("create.success.description")}
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
              <p className="text-xs font-medium text-muted">{t("create.success.folder")}</p>
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

            {info.uploadInProgress ? (
              <div
                className="min-w-0 space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
                aria-live="polite"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">
                    {t("create.success.uploadLiveLabel")}
                  </span>
                  <span className="tabular-nums text-muted">
                    {liveUpload ? `${Math.round(livePercent)}%` : "…"}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,var(--ats-progress-from),var(--ats-progress-to))] transition-[width] duration-300 ease-out"
                    style={{
                      width: liveUpload ? `${livePercent}%` : "8%",
                      opacity: liveUpload ? 1 : 0.55,
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-muted">
                  <span className="tabular-nums">
                    {liveBytes ?? t("create.success.uploadLiveWaiting")}
                  </span>
                  {queuedCount > 0 ? (
                    <span>
                      {t("create.success.uploadQueued", { count: queuedCount })}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

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
              {t("create.success.openLocation")}
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
                {t("create.success.play")}
              </Button>
            )}
          </div>
          <Button type="button" className="w-full sm:w-auto" onClick={onClose}>
            {t("common.actions.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
