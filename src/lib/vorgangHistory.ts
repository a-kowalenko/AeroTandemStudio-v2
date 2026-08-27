import { invoke } from "@tauri-apps/api/core";
import type { QrPreview } from "./tauri";
import { useHistoryStore } from "@/store/historyStore";
import {
  classifyBulkPreflight,
  primaryPreflightReasonCode,
} from "./uploadPreflight";
import {
  isOutstandingVorgangUpload,
} from "./uploadState";

export {
  canRetryVorgangUpload,
  isListUploadStatus,
  isOutstandingUploadState,
  isOutstandingVorgangUpload,
  isRetryableUploadState,
} from "./uploadState";

export type VorgangEntry = {
  id: number;
  created_at: string;
  gast: string;
  vorname: string | null;
  nachname: string | null;
  kunden_id: string | null;
  booking_id: string | null;
  kunden_id_hash: string | null;
  booking_id_hash: string | null;
  datum: string;
  ort: string;
  tandemmaster: string;
  videospringer: string;
  video_mode: string;
  form_mode: string;
  manual_entry_mode: string;
  handcam_foto: boolean;
  handcam_video: boolean;
  outside_foto: boolean;
  outside_video: boolean;
  ist_bezahlt_handcam_foto: boolean;
  ist_bezahlt_handcam_video: boolean;
  ist_bezahlt_outside_foto: boolean;
  ist_bezahlt_outside_video: boolean;
  base_output_dir: string;
  base_filename: string;
  encoder: string;
  intro_created: boolean;
  body_clips: number;
  photos_copied: number;
  watermark_photos: number;
  marker_path: string;
  reused_preview: boolean;
  /** Persisted QR hit-frame (QR-mode Vorgänge); deleted with the history entry. */
  qr_preview: QrPreview | null;
  file_count: number;
  /** AMS handoff correlation id (empty for Lokal / older rows). */
  correlation_id: string;
  /** Last-known AMS outbox state (`pending` until AMS writes). */
  ams_state: string;
  ams_updated_at: string;
  ams_error_code: string;
  ams_error_message: string;
  ams_archive: string;
  /** `bridge` | `outbox` | `local` | `cached` */
  ams_source: string;
  /** SMB upload: `none` | `pending` | `uploading` | `done` | `failed` | `cancelled`. */
  upload_state: string;
  append_count: number;
  last_append_correlation_id: string;
  last_append_ams_state: string;
  last_append_ams_error_code: string;
  last_append_ams_error_message: string;
  last_append_folder_path: string;
};

export type VorgangFileEntry = {
  id: number;
  vorgang_id: number;
  filename: string;
  media_type: string;
  role: string;
  size_bytes: number | null;
  path: string | null;
  append_id: number | null;
  append_folder_name: string | null;
};

export type HandoffStatus = {
  correlation_id: string;
  state: string;
  updated_at: string;
  error: { code: string; message: string } | null;
  ams: { history_id: string | null; archive: string | null };
  /** `bridge` | `outbox` | `cached` | `local` */
  source?: string;
  /** Live Bridge/Outbox unavailable; payload may be cached. */
  offline?: boolean;
};

export async function listVorgaenge(
  limit?: number,
  search?: string,
): Promise<VorgangEntry[]> {
  return invoke<VorgangEntry[]>("list_vorgaenge", {
    limit: limit ?? 500,
    search: search ?? null,
  });
}

export async function listVorgangDateien(
  vorgangId: number,
): Promise<VorgangFileEntry[]> {
  return invoke<VorgangFileEntry[]>("list_vorgang_dateien", {
    vorgangId,
  });
}

export async function getHandoffStatus(
  correlationId: string,
  baseOutputDir: string,
  vorgangId?: number | null,
): Promise<HandoffStatus | null> {
  return invoke<HandoffStatus | null>("get_handoff_status", {
    correlationId,
    baseOutputDir,
    vorgangId: vorgangId ?? null,
  });
}

export async function deleteVorgaenge(ids: number[]): Promise<void> {
  return invoke("delete_vorgaenge", { ids });
}

export type VorgangUploadState =
  | "none"
  | "pending"
  | "uploading"
  | "done"
  | "failed"
  | "cancelled";

/** Persist SMB upload lifecycle (separate from AMS handoff state). */
export async function setVorgangUploadState(
  uploadState: VorgangUploadState,
  opts?: { vorgangId?: number | null; correlationId?: string | null },
): Promise<void> {
  return invoke("set_vorgang_upload_state", {
    vorgangId: opts?.vorgangId ?? null,
    correlationId: opts?.correlationId ?? null,
    uploadState,
  });
}

export type UploadPreflightIssue = {
  code: string;
  path: string;
  detail: string;
};

export type UploadPreflightResult = {
  ok: boolean;
  hard_errors: UploadPreflightIssue[];
  soft_warnings: UploadPreflightIssue[];
};

/** Prefight local job folder vs `_ams_manifest.v1.json` before SMB retry. */
export async function preflightVorgangUpload(
  vorgangId: number,
): Promise<UploadPreflightResult> {
  return invoke<UploadPreflightResult>("preflight_vorgang_upload", {
    vorgangId,
  });
}

export type DeliveryResyncReport = {
  removed_paths: string[];
  file_count: number;
};

export type DeleteExtraFilesReport = {
  deleted_paths: string[];
};

/** Align on-disk delivery list with files currently in the output folder (Phase 31.4). */
export async function resyncVorgangDeliveryList(
  vorgangId: number,
): Promise<DeliveryResyncReport> {
  return invoke<DeliveryResyncReport>("resync_vorgang_delivery_list", {
    vorgangId,
  });
}

/** Delete extra payload files under the job folder before upload retry (Phase 31.5). */
export async function deleteVorgangExtraFiles(
  vorgangId: number,
  relativePaths: string[],
): Promise<DeleteExtraFilesReport> {
  return invoke<DeleteExtraFilesReport>("delete_vorgang_extra_files", {
    vorgangId,
    relativePaths,
  });
}

export type VorgangUploadRetryOptions = {
  omittedFileCount?: number;
  includedExtraCount?: number;
};

/** Count badge / reconnect toast: pending + failed only. */
export function countPendingUploads(
  entries: VorgangEntry[],
  uploadToServer: boolean,
): number {
  if (!uploadToServer) return 0;
  return entries.reduce(
    (n, e) => n + (isOutstandingVorgangUpload(e, true) ? 1 : 0),
    0,
  );
}

/**
 * Bulk candidates: outstanding rows, oldest first (`created_at` ASC, then id).
 */
export function pendingUploadCandidates(
  entries: VorgangEntry[],
  uploadToServer: boolean,
): VorgangEntry[] {
  if (!uploadToServer) return [];
  return entries
    .filter((e) => isOutstandingVorgangUpload(e, true))
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(
        /(?:Z|[+-]\d{2}:?\d{2})$/i.test(a.created_at.trim())
          ? a.created_at
          : `${a.created_at}Z`,
      );
      const tb = Date.parse(
        /(?:Z|[+-]\d{2}:?\d{2})$/i.test(b.created_at.trim())
          ? b.created_at
          : `${b.created_at}Z`,
      );
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      if (na !== nb) return na - nb;
      return a.id - b.id;
    });
}

export type BulkUploadSummaryItem = {
  guest: string;
  vorgangId: number;
  reasonCode: string;
};

export type BulkScanEntry = VorgangEntry & { reasonCodes: string[] };

export type BulkUploadScanResult = {
  ready: VorgangEntry[];
  needsDecision: BulkScanEntry[];
  blocked: BulkScanEntry[];
};

export type BulkPhase2Session = {
  entries: BulkScanEntry[];
  summary: BulkUploadSummary;
};

export type BulkUploadSummary = {
  ok: number;
  /** Phase 2 uploads after user decision (Phase 31.6). */
  decided: number;
  skipped: number;
  failed: number;
  blocked: number;
  /** Remaining candidates not attempted (cancel or server down mid-bulk). */
  aborted: boolean;
  remaining: number;
  blockedItems: BulkUploadSummaryItem[];
  skippedItems: BulkUploadSummaryItem[];
};

export function createEmptyBulkUploadSummary(): BulkUploadSummary {
  return {
    ok: 0,
    decided: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    aborted: false,
    remaining: 0,
    blockedItems: [],
    skippedItems: [],
  };
}

/** Preflight all bulk candidates once before confirm (Phase 31.6). */
export async function scanBulkUploadCandidates(
  entries: VorgangEntry[],
): Promise<BulkUploadScanResult> {
  const ready: VorgangEntry[] = [];
  const needsDecision: BulkScanEntry[] = [];
  const blocked: BulkScanEntry[] = [];

  for (const entry of entries) {
    try {
      const pf = await preflightVorgangUpload(entry.id);
      const cls = classifyBulkPreflight(pf);
      if (cls.bucket === "ready") {
        ready.push(entry);
      } else if (cls.bucket === "needs_decision") {
        needsDecision.push({ ...entry, reasonCodes: cls.reasonCodes });
      } else {
        blocked.push({ ...entry, reasonCodes: cls.reasonCodes });
      }
    } catch {
      blocked.push({ ...entry, reasonCodes: ["preflight_error"] });
    }
  }

  return { ready, needsDecision, blocked };
}

export function bulkSummaryItemFromScanEntry(
  entry: BulkScanEntry,
): BulkUploadSummaryItem {
  return {
    guest: entry.gast,
    vorgangId: entry.id,
    reasonCode: primaryPreflightReasonCode(entry.reasonCodes),
  };
}

/** Refresh Historie badge counter from SQLite (no auto-upload). */
export async function refreshPendingUploadCount(
  uploadToServer: boolean,
): Promise<number> {
  if (!uploadToServer) {
    useHistoryStore.getState().setPendingUploadCount(0);
    return 0;
  }
  const rows = await listVorgaenge(500);
  const n = countPendingUploads(rows, true);
  useHistoryStore.getState().setPendingUploadCount(n);
  return n;
}

export type AppendCategoryId =
  | "handcam_video"
  | "handcam_foto"
  | "outside_video"
  | "outside_foto";

export type AppendMediaItem = {
  path: string;
  category: AppendCategoryId;
  preview: boolean;
};

export type AppendJobResult = {
  correlation_id: string;
  folder_name: string;
  folder_path: string;
  file_count: number;
  preview_count: number;
  categories: string[];
};

export type VorgangAppendEntry = {
  id: number;
  vorgang_id: number;
  correlation_id: string;
  folder_name: string;
  folder_path: string;
  created_at: string;
  file_count: number;
  preview_count: number;
  categories: string[];
  ams_state: string;
  ams_updated_at: string;
  ams_error_code: string;
  ams_error_message: string;
};

export async function listVorgangAppends(
  vorgangId: number,
): Promise<VorgangAppendEntry[]> {
  return invoke<VorgangAppendEntry[]>("list_vorgang_appends", { vorgangId });
}

export async function createAppendJob(
  vorgangId: number,
  items: AppendMediaItem[],
): Promise<AppendJobResult> {
  return invoke<AppendJobResult>("create_append_job", { vorgangId, items });
}
