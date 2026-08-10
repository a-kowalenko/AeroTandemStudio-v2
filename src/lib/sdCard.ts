/** SD-card related Tauri invoke wrappers and types. */

import { invoke } from "@tauri-apps/api/core";

export type SdDriveInfo = {
  drive: string;
  dcim_path: string;
  ready: boolean;
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

export type ListSdFilesResult = {
  drive: string;
  files: SdFileInfo[];
  total_size_mb: number;
  total_size_bytes: number;
};

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
};

/** File-count progress for clear / import (i/n). */
export type WorkflowProgress = {
  stage: "clear" | "import" | string;
  current: number;
  total: number;
  percent: number;
  label: string;
};

export type SdWorkflowActions = {
  backup: boolean;
  import: boolean;
  clear: boolean;
  eject: boolean;
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
  return invoke<ListSdFilesResult>("list_sd_files", { drive });
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

export async function getMediaThumbnail(
  path: string,
): Promise<{ path: string; data_url: string }> {
  return invoke("get_media_thumbnail", { path });
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
