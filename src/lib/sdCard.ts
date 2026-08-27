/** SD-card related Tauri invoke wrappers and types. */

import { invoke } from "@tauri-apps/api/core";
import { tr } from "@/i18n";
import { isSidecarPath } from "./media";

export type SdDriveInfo = {
  drive: string;
  dcim_path: string;
  ready: boolean;
  /** Volume label when available (may be empty / generic). */
  volume_name: string;
};

export type SdFileInfo = {
  path: string;
  filename: string;
  size_bytes: number;
  is_video: boolean;
  mtime: number;
  display_epoch: number;
  already_processed: boolean;
};

/** USB/MTP camera source (`mtp:gopro:…`). */
export function isMtpDrive(drive: string | null | undefined): boolean {
  return Boolean(drive?.startsWith("mtp:"));
}

export type SdFileEnrichment = {
  path: string;
  display_epoch: number;
  already_processed: boolean;
};

export type ListEmptyReason = "no_media" | "filtered_only";

export type ListSdFilesResult = {
  drive: string;
  files: SdFileInfo[];
  total_size_mb: number;
  total_size_bytes: number;
  empty_reason?: ListEmptyReason | null;
};

export function emptyCatalogLabel(
  drive: string | null | undefined,
  reason?: ListEmptyReason | null,
): string {
  if (reason === "filtered_only") {
    return tr("sd.catalog.filteredOnly");
  }
  return isMtpDrive(drive)
    ? tr("sd.catalog.mtpEmpty")
    : tr("sd.catalog.sdEmpty");
}

export function isEmptyCatalogMessage(msg: string): boolean {
  return /Keine Medien auf der Kamera gefunden|Keine Mediendateien auf der|Keine importierbaren Medien/.test(
    msg,
  );
}

export type BackupResult = {
  success: boolean;
  backup_path: string | null;
  error_message: string | null;
  copied_count: number;
  skipped_count: number;
  copied_dest_paths: string[];
  copied_source_paths: string[];
  secondary_backup_path: string | null;
  secondary_warning: string | null;
  /** True when second-path mirror was queued in the background. */
  secondary_async_started: boolean;
  /** Null when clear was not requested; otherwise files removed / deleted. */
  clear_deleted_count: number | null;
  /** Soft-fail for clear-after-backup (backup may still succeed). */
  clear_warning: string | null;
};

export type SecondaryBackupEvent = {
  state: "started" | "progress" | "done" | "failed" | "cancelled" | string;
  job_id: string;
  primary_path: string;
  secondary_path: string | null;
  current: number;
  total: number;
  percent: number;
  current_bytes?: number;
  total_bytes?: number;
  speed_bps?: number;
  file_name?: string | null;
  message?: string | null;
};

export type ImportSdResult = {
  imported_videos: string[];
  imported_photos: string[];
  skipped: number;
};

export type SdInsertedPayload = {
  drive: string;
  file_count: number;
  total_size_mb: number;
  needs_confirmation: boolean;
  size_limit_exceeded: boolean;
  limit_mb: number;
  /** True when the card was just plugged in (not only present at monitor start). */
  hotplug: boolean;
};

export type BackupProgress = {
  current_mb: number;
  total_mb: number;
  speed_mbps: number;
  percent: number;
  /** 1-based file index while copying. */
  file_index?: number | null;
  file_total?: number | null;
  file_name?: string | null;
};

/** File-count progress for clear / import (i/n). */
export type WorkflowProgress = {
  stage: "clear" | "import" | string;
  current: number;
  total: number;
  percent: number;
  label: string;
  /** Present during import copy (byte progress). */
  current_mb?: number | null;
  total_mb?: number | null;
  speed_mbps?: number | null;
  /** 1-based file index during import copy / probe. */
  file_index?: number | null;
  file_total?: number | null;
  file_name?: string | null;
};

export type SdWorkflowActions = {
  backup: boolean;
  import: boolean;
  clear: boolean;
  eject: boolean;
  /**
   * Confirm-dialog override for post-import QR.
   * `undefined` = use settings (auto mode), but skip when session already
   * has QR kundedata (`form_mode === "kunde"`).
   * `true` = force scan (even with active QR session).
   * `false` = skip.
   */
  scanQr?: boolean;
};

export type ProcessedFileEntry = {
  id: number;
  filename: string;
  size_bytes: number;
  media_type: string;
  first_seen_at: string;
  backed_up_at: string | null;
  imported_at: string | null;
  created_at: string | null;
};

export type SdStatusSnapshot = {
  monitoring: boolean;
  drives: SdDriveInfo[];
  backup_in_progress: boolean;
};

export async function startSdMonitor(): Promise<boolean> {
  return invoke<boolean>("start_sd_monitor");
}

export async function stopSdMonitor(): Promise<void> {
  return invoke("stop_sd_monitor");
}

export async function getSdStatus(): Promise<SdStatusSnapshot> {
  return invoke<SdStatusSnapshot>("get_sd_status");
}

export async function scanSdDrives(): Promise<SdDriveInfo[]> {
  return invoke<SdDriveInfo[]>("scan_sd_drives");
}

export async function listSdFiles(drive: string): Promise<ListSdFilesResult> {
  const result = await invoke<ListSdFilesResult>("list_sd_files", { drive });
  const files = result.files.filter(
    (f) => !isSidecarPath(f.filename) && !isSidecarPath(f.path),
  );
  if (files.length === result.files.length) {
    return result;
  }
  const total_size_bytes = files.reduce((sum, f) => sum + f.size_bytes, 0);
  return {
    ...result,
    files,
    total_size_bytes,
    total_size_mb: total_size_bytes / (1024 * 1024),
    empty_reason:
      files.length === 0
        ? result.files.length > 0
          ? "filtered_only"
          : (result.empty_reason ?? "no_media")
        : null,
  };
}

/** Fill EXIF dates + history flags after a fast `listSdFiles` (non-blocking for the dialog). */
export async function enrichSdFiles(
  drive: string,
  paths?: string[] | null,
): Promise<SdFileEnrichment[]> {
  return invoke<SdFileEnrichment[]>("enrich_sd_files", {
    drive,
    paths: paths ?? null,
  });
}

export async function backupSdCard(
  drive: string,
  selectedFiles?: string[] | null,
  clearAfter?: boolean | null,
): Promise<BackupResult> {
  return invoke<BackupResult>("backup_sd_card", {
    drive,
    selectedFiles: selectedFiles ?? null,
    clearAfter: clearAfter ?? null,
  });
}

export async function importSdFiles(paths: string[]): Promise<ImportSdResult> {
  return invoke<ImportSdResult>("import_sd_files", { paths });
}

export async function clearSdFiles(paths: string[]): Promise<number> {
  return invoke<number>("clear_sd_files", { paths });
}

export async function declineSdBackup(drive: string): Promise<void> {
  return invoke("decline_sd_backup", { drive });
}

export async function ejectSdCard(drive: string): Promise<void> {
  return invoke("eject_sd_card", { drive });
}

export type ThumbQuality = "lq" | "hq" | "preview";

export type MediaThumbnailResult = {
  path: string;
  /** Loopback HTTP URL (OPT-4) — preferred over Base64 IPC. */
  url?: string | null;
  /** Legacy Base64 data URL when HTTP is unavailable. */
  data_url?: string | null;
  quality?: string;
};

/** Pick display URL: HTTP first, then legacy data URL. */
export function thumbnailDisplayUrl(res: MediaThumbnailResult): string {
  const http = res.url?.trim();
  if (http) return http;
  const data = res.data_url?.trim();
  if (data) return data;
  return "";
}

export async function getMediaThumbnail(
  path: string,
  quality: ThumbQuality = "lq",
): Promise<MediaThumbnailResult> {
  return invoke<MediaThumbnailResult>("get_media_thumbnail", { path, quality });
}

export async function listProcessedFiles(
  limit?: number,
  search?: string,
): Promise<ProcessedFileEntry[]> {
  return invoke<ProcessedFileEntry[]>("list_processed_files", {
    limit: limit ?? 1000,
    search: search ?? null,
  });
}

export async function deleteProcessedFiles(ids: number[]): Promise<void> {
  return invoke("delete_processed_files", { ids });
}

export async function purgeProcessedFiles(): Promise<void> {
  return invoke("purge_processed_files");
}
