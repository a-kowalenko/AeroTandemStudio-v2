import { tr } from "@/i18n";
import { formatBytes } from "./formatBytes";
import { formatSpeed } from "./formatSpeed";
import type { UploadProgressEvent } from "./tauri";
import type { WorkflowProgressSnapshot } from "./workflowProgress";

export type UploadCompactParts = {
  percent: number;
  /** `current / total` byte sizes, or null when unknown. */
  bytesLabel: string | null;
  /** Throughput label, or empty when unknown. */
  speedLabel: string;
};

/** Compact-bar fields for Phase 37.2 (Bar / % / MB / Speed). */
export function formatUploadCompactParts(
  p: UploadProgressEvent | null,
): UploadCompactParts {
  if (!p) {
    return { percent: 0, bytesLabel: null, speedLabel: "" };
  }
  const bytesLabel =
    p.total_bytes > 0
      ? tr("app.upload.bytesProgress", {
          current: formatBytes(p.current_bytes),
          total: formatBytes(p.total_bytes),
        })
      : null;
  return {
    percent: Math.max(0, Math.min(100, p.percent)),
    bytesLabel,
    speedLabel: formatSpeed(p.speed_bps ?? 0),
  };
}

/** Map secondary-backup event → compact metrics (same labels as upload bar). */
export function formatSecondaryBackupCompactParts(input: {
  percent: number;
  current_bytes?: number;
  total_bytes?: number;
  speed_bps?: number;
} | null): UploadCompactParts {
  if (!input) {
    return { percent: 0, bytesLabel: null, speedLabel: "" };
  }
  return formatUploadCompactParts({
    percent: input.percent,
    current_file: 0,
    total_files: 0,
    current_bytes: input.current_bytes ?? 0,
    total_bytes: input.total_bytes ?? 0,
    speed_bps: input.speed_bps ?? 0,
    filename: "",
    status: "progress",
  });
}

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

  const compact = formatUploadCompactParts(p);
  const detailParts: string[] = [];
  if (compact.bytesLabel) detailParts.push(compact.bytesLabel);
  if (compact.speedLabel) detailParts.push(compact.speedLabel);

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
