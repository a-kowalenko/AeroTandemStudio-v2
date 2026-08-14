import type { BackupProgress, WorkflowProgress } from "./sdCard";
import {
  summarizeQrScanProgress,
  type QrClipFrameProgress,
  type QrFileProgress,
  type QrFollowupStatus,
  type QrScanJobStage,
  type QrScanLegend,
  type QrScanPhase,
} from "../store/qrScanStore";

export type WorkflowProgressSnapshot = {
  percent: number;
  label?: string;
  detail?: string;
  indeterminate?: boolean;
  /** QR-style: no percent; show metric + activity instead. */
  hidePercent?: boolean;
  /** Primary counter, e.g. `3/15` (Momente / Prüfpunkte). */
  metric?: string;
  /** Short unit under/beside metric, e.g. `Momente`. */
  metricLabel?: string;
  /** Color legend under QR stripes. */
  legend?: QrScanLegend;
  /** Optional file-level segments for QR batch progress. */
  fileProgress?: QrFileProgress;
};

export type WorkflowTaskProgress = {
  taskId: number;
  percent: number;
  label?: string;
  status?: string;
};

export type WorkflowProgressStage =
  | "sd-backup"
  | "sd-import"
  | "sd-clear"
  | "sd-qr"
  | "import"
  | "qr"
  | "preview"
  | "cut"
  | "create"
  | "done";

export function formatWorkflowDetail(p: WorkflowProgress): string | undefined {
  const parts: string[] = [];
  if (p.total_mb != null && p.total_mb > 0 && p.current_mb != null) {
    parts.push(`${p.current_mb.toFixed(0)}/${p.total_mb.toFixed(0)} MB`);
  }
  if (p.speed_mbps != null && p.speed_mbps > 0) {
    parts.push(`${p.speed_mbps.toFixed(1)} MB/s`);
  }
  if (
    (p.file_index == null || p.file_index <= 0) &&
    p.total > 0 &&
    (p.current_mb == null || p.total_mb == null)
  ) {
    parts.push(`${p.current}/${p.total}`);
  }
  const name = p.file_name?.trim();
  if (name) {
    parts.push(name);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatWorkflowLabel(p: WorkflowProgress, fallback: string): string {
  const base = (p.label || fallback).trim() || fallback;
  if (p.file_total != null && p.file_total > 0 && p.file_index != null && p.file_index > 0) {
    return `${base} (${p.file_index}/${p.file_total})`;
  }
  return base;
}

export function resolveSdWorkflowProgress(opts: {
  active: boolean;
  phase: string;
  backupProgress: BackupProgress | null;
  workflowProgress: WorkflowProgress | null;
  loadingMessage: string;
  qrBusy: boolean;
  qrStage: QrScanJobStage;
  qrByPath: Record<string, QrScanPhase>;
  qrFollowup: QrFollowupStatus | null;
  qrClipProgress?: Record<string, QrClipFrameProgress>;
  qrScanOrder?: string[];
  qrPhotoEdgeLimited?: boolean;
}): WorkflowProgressSnapshot | null {
  if (!opts.active) return null;

  const { phase, backupProgress, workflowProgress, loadingMessage } = opts;
  const msg = loadingMessage.trim();

  if (
    workflowProgress &&
    (workflowProgress.stage === "clear" || workflowProgress.stage === "import")
  ) {
    const fallback =
      workflowProgress.stage === "clear"
        ? "SD wird bereinigt…"
        : msg || "Importiere…";
    return {
      percent: workflowProgress.percent,
      label: formatWorkflowLabel(workflowProgress, fallback),
      detail: formatWorkflowDetail(workflowProgress),
    };
  }

  if (backupProgress) {
    const isClearing = phase === "clearing";
    const detailParts = [
      `${backupProgress.current_mb.toFixed(0)}/${backupProgress.total_mb.toFixed(0)} MB`,
    ];
    if (backupProgress.speed_mbps > 0 && !isClearing) {
      detailParts.push(`${backupProgress.speed_mbps.toFixed(1)} MB/s`);
    }
    const fileName = backupProgress.file_name?.trim();
    if (fileName && !isClearing) {
      detailParts.push(fileName);
    }
    let label = isClearing ? "SD wird bereinigt…" : msg || "SD-Backup läuft…";
    if (
      !isClearing &&
      backupProgress.file_total != null &&
      backupProgress.file_total > 0 &&
      backupProgress.file_index != null &&
      backupProgress.file_index > 0
    ) {
      label = `${label} (${backupProgress.file_index}/${backupProgress.file_total})`;
    }
    return {
      percent: backupProgress.percent,
      label,
      detail: detailParts.join(" · "),
    };
  }

  if (phase === "clearing") {
    return {
      percent: 100,
      label: "SD wird bereinigt…",
      indeterminate: true,
    };
  }

  const qrActive = opts.qrBusy || opts.qrStage !== "idle" || /qr/i.test(msg);
  if (qrActive) {
    const summary = summarizeQrScanProgress(
      opts.qrByPath,
      opts.qrStage,
      opts.qrFollowup,
      opts.qrClipProgress,
      opts.qrScanOrder,
      opts.qrPhotoEdgeLimited,
    );
    return {
      percent: summary.percent,
      label:
        msg &&
        !/^QR-Scan…?$/i.test(msg) &&
        !/^QR-Code/i.test(msg) &&
        opts.qrStage !== "followup"
          ? msg
          : summary.label,
      detail: summary.detail || undefined,
      indeterminate: summary.indeterminate,
      hidePercent: summary.hidePercent,
      metric: summary.metric,
      metricLabel: summary.metricLabel,
      legend: summary.legend,
      fileProgress: summary.fileProgress,
    };
  }

  if (phase === "importing" || /import/i.test(msg)) {
    return {
      percent: 0,
      label: msg || "Importiere SD-Dateien…",
      indeterminate: true,
    };
  }

  return {
    percent: 0,
    label: msg || "SD-Verarbeitung…",
    indeterminate: true,
  };
}

export function inferWorkflowStage(opts: {
  sdWorkflowActive: boolean;
  sdPhase: string;
  qrScanBusy: boolean;
  manualImport: boolean;
  manualQr: boolean;
  encodeBusy: boolean;
  status: string;
  sdProgress: WorkflowProgressSnapshot | null;
}): WorkflowProgressStage {
  const status = opts.status.trim();
  if (/preview/i.test(status)) return "preview";
  if (/schnitt|teilen|rückgängig/i.test(status)) return "cut";
  if (opts.encodeBusy) return "create";

  if (opts.sdWorkflowActive && opts.sdProgress) {
    if (opts.qrScanBusy || /qr/i.test(opts.sdProgress.label ?? "")) return "sd-qr";
    if (opts.sdPhase === "clearing" || /bereinigt/i.test(opts.sdProgress.label ?? "")) {
      return "sd-clear";
    }
    if (opts.sdPhase === "importing" || /import/i.test(opts.sdProgress.label ?? "")) {
      return "sd-import";
    }
    return "sd-backup";
  }

  if (opts.manualQr) return "qr";
  if (opts.manualImport) return "import";
  if (status && status !== "cancelled") return "done";
  return "create";
}

export function workflowStageSubtitle(
  stage: WorkflowProgressStage,
  opts: {
    sdWorkflowActive: boolean;
    sdPhase: string;
    qrScanBusy: boolean;
    encodeBusy: boolean;
    manualImport: boolean;
    manualQr: boolean;
  },
): string {
  if (stage === "preview") return "Vorschau wird erzeugt";
  if (stage === "cut") return "Schnitt wird angewendet";
  if (stage === "done") return "Zuletzt abgeschlossener Lauf";

  if (opts.sdWorkflowActive && !opts.encodeBusy) {
    if (opts.sdPhase === "clearing") {
      return "SD wird bereinigt — Abbrechen nicht möglich";
    }
    return opts.qrScanBusy
      ? "SD — QR-Code-Suche (Abbrechen stoppt nur die Suche)"
      : "SD — Backup, Import und weitere Aktionen (Abbrechen stoppt den Lauf)";
  }
  if (opts.manualImport && !opts.encodeBusy) {
    return "Medien werden in den Arbeitsordner kopiert — Abbrechen verwirft den Import";
  }
  if (opts.manualQr && !opts.encodeBusy) {
    return "QR-Code-Suche — Abbrechen stoppt die Suche";
  }
  if (opts.encodeBusy) return "Aktueller Vorgang — Abbrechen stoppt FFmpeg.";
  return "Zuletzt abgeschlossener Lauf";
}
