import { tr } from "@/i18n";
import { formatBytes } from "./formatBytes";
import { formatSpeed } from "./formatSpeed";
import type { UploadProgressEvent } from "./tauri";
import type { WorkflowProgressSnapshot } from "./workflowProgress";

export function formatUploadProgressSnapshot(
  p: UploadProgressEvent,
): WorkflowProgressSnapshot {
  const label =
    p.total_files > 0
      ? tr("app.upload.labelWithFiles", {
          current: p.current_file,
          total: p.total_files,
        })
      : tr("app.upload.title");

  const detailParts: string[] = [];
  if (p.total_bytes > 0) {
    detailParts.push(
      tr("app.upload.bytesProgress", {
        current: formatBytes(p.current_bytes),
        total: formatBytes(p.total_bytes),
      }),
    );
  }
  const speed = formatSpeed(p.speed_bps ?? 0);
  if (speed) detailParts.push(speed);

  return {
    percent: p.percent,
    label,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
  };
}

/** Compact tooltip line for the header server chip during upload. */
export function formatUploadProgressTooltip(p: UploadProgressEvent): string | null {
  const snapshot = formatUploadProgressSnapshot(p);
  return snapshot.detail ?? null;
}
