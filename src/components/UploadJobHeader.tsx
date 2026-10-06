import { useTranslation } from "react-i18next";
import { FolderOpen, Play, Upload } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import type { UploadQueueJobPreview } from "@/lib/uploadQueue";
import { pathBasename } from "@/lib/createRunOutcome";
import type { ReactNode } from "react";

type Props = {
  job: UploadQueueJobPreview;
  /** e.g. Abbrechen */
  headerEnd?: ReactNode;
  /** e.g. collapse chevron */
  trailingControl?: ReactNode;
  className?: string;
};

/**
 * Expanded upload header for Nachholen / append — same geometry as
 * CreateOutcomeCard (title, guest, meta, Abspielen/Ordner, actions).
 */
export function UploadJobHeader({
  job,
  headerEnd,
  trailingControl,
  className,
}: Props) {
  const { t } = useTranslation();
  const outputDir = job.localDir?.trim() ?? "";
  const videoPath = job.videoPath?.trim() ?? "";
  const guest =
    job.guestLabel?.trim() || job.folderName?.trim() || "";

  const metaParts: string[] = [];
  if (job.hasVideo) metaParts.push(t("create.success.videoCreated"));
  if (job.photosCopied > 0) {
    metaParts.push(
      t(
        job.photosCopied === 1
          ? "create.success.photosCopied"
          : "create.success.photosCopiedMany",
        { count: job.photosCopied },
      ),
    );
  }
  const tm = job.tandemmaster?.trim();
  const vs = job.videospringer?.trim();
  if (tm) metaParts.push(t("create.success.crewTm", { name: tm }));
  if (vs) metaParts.push(t("create.success.crewVs", { name: vs }));
  const metaLine = metaParts.join(" · ");

  const titleKey =
    job.source === "history" || job.source === "bulk"
      ? "history.retryTitle"
      : "app.upload.title";

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
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={t(titleKey)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Upload className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              {t(titleKey)}
            </h2>
          </div>
          {guest ? (
            <p className="mt-1 text-sm font-medium text-foreground">{guest}</p>
          ) : null}
          {metaLine ? (
            <p className="mt-1 text-xs text-muted">{metaLine}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {videoPath ? (
            <Button
              type="button"
              size="sm"
              onClick={() => void playVideo()}
              title={pathBasename(videoPath)}
            >
              <Play className="h-3.5 w-3.5 shrink-0" />
              {t("create.success.play")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!outputDir}
            onClick={() => void openOutputDir()}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            {t("create.success.folder")}
          </Button>
          {headerEnd}
          {trailingControl}
        </div>
      </div>
    </div>
  );
}
