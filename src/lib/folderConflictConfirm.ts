/** Soft output-folder conflict before create (Phase 30). */

import type { OutputFolderProbe } from "./tauri";

export type FolderConflictConfirmState = {
  folderName: string;
  folderPath: string;
  hasMarker: boolean;
  videoFileCount: number;
  photoFileCount: number;
  otherFileCount: number;
  totalFileCount: number;
  uploadToServer: boolean;
};

export function shouldWarnFolderConflict(probe: OutputFolderProbe): boolean {
  return Boolean(probe.exists && !probe.is_empty);
}

/** Stable signature so we only confirm once per planned folder until form/storage changes. */
export function folderConflictSignature(probe: OutputFolderProbe): string {
  return [
    probe.folder_path,
    String(probe.total_file_count),
    probe.has_marker ? "1" : "0",
    String(probe.video_file_count),
    String(probe.photo_file_count),
  ].join("|");
}

export function toFolderConflictConfirmState(
  probe: OutputFolderProbe,
  uploadToServer: boolean,
): FolderConflictConfirmState {
  return {
    folderName: probe.folder_name,
    folderPath: probe.folder_path,
    hasMarker: probe.has_marker,
    videoFileCount: probe.video_file_count,
    photoFileCount: probe.photo_file_count,
    otherFileCount: probe.other_file_count,
    totalFileCount: probe.total_file_count,
    uploadToServer,
  };
}
