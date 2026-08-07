/** Shared types and typed Tauri invoke wrappers. */

import { invoke } from "@tauri-apps/api/core";

export type VideoMetadata = {
  path: string;
  filename: string;
  duration_secs: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  size_bytes: number;
};

export type Kunde = {
  kunden_id?: string | null;
  kunden_id_hash?: string | null;
  booking_id?: string | null;
  booking_id_hash?: string | null;
  vorname?: string | null;
  nachname?: string | null;
  email?: string | null;
  telefon?: string | null;
  gast: string;
  tandemmaster: string;
  videospringer: string;
  datum: string;
  ort: string;
  video_mode: string;
  form_mode: string;
  handcam_foto: boolean;
  handcam_video: boolean;
  outside_foto: boolean;
  outside_video: boolean;
  ist_bezahlt_handcam_foto: boolean;
  ist_bezahlt_handcam_video: boolean;
  ist_bezahlt_outside_foto: boolean;
  ist_bezahlt_outside_video: boolean;
};

export type CrewMember = {
  name: string;
  tandemmaster: boolean;
  videospringer: boolean;
};

export type AppConfig = {
  speicherort: string;
  ort: string;
  dauer: number;
  intro_enabled: boolean;
  outside_video: boolean;
  gast_name: string;
  tandemmaster: string;
  videospringer: string;
  /** Editable crew roster; roles filter form combobox suggestions. */
  crew_list: CrewMember[];
  upload_to_server: boolean;
  server_url: string;
  server_login: string;
  server_password: string;
  hardware_acceleration_enabled: boolean;
  parallel_processing_enabled: boolean;
  video_codec: string;
  encoding_strategy: string;
  reencode_matching_clips: boolean;
  preview_encode_crf: number;
  qr_check_enabled: boolean;
  photo_qr_check_enabled: boolean;
  qr_video_scan_seconds: number;
  qr_remove_photo_after_scan: boolean;
  qr_remove_video_after_scan: boolean;
  qr_remove_video_max_duration_sec: number;
  sd_auto_backup: boolean;
  sd_backup_folder: string;
  sd_backup_mode: string;
  sd_clear_after_backup: boolean;
  sd_auto_import: boolean;
  sd_skip_processed: boolean;
  sd_size_limit_enabled: boolean;
  sd_size_limit_mb: number;
  oldschool_mode: boolean;
  keep_tandemmaster_on_session_reset: boolean;
  keep_videospringer_on_session_reset: boolean;
  /** Clear imported media and session form after successful create. */
  auto_clear_files_after_creation: boolean;
};

/** Fixed Ort presets; free text remains allowed in the combobox. */
export const ORT_OPTIONS = ["Calden", "Gera"] as const;

export const DEFAULT_CREW_LIST: CrewMember[] = [
  { name: "Alberto", tandemmaster: true, videospringer: false },
  { name: "Ana", tandemmaster: true, videospringer: true },
  { name: "Andy", tandemmaster: true, videospringer: true },
  { name: "Chris", tandemmaster: true, videospringer: false },
  { name: "Cornelius", tandemmaster: true, videospringer: false },
  { name: "Futti", tandemmaster: true, videospringer: true },
  { name: "Harry", tandemmaster: true, videospringer: true },
  { name: "Henrik", tandemmaster: true, videospringer: true },
  { name: "Jan", tandemmaster: true, videospringer: false },
  { name: "Kai", tandemmaster: false, videospringer: true },
  { name: "Max", tandemmaster: true, videospringer: false },
  { name: "Mayo", tandemmaster: true, videospringer: false },
  { name: "Pascal", tandemmaster: true, videospringer: false },
  { name: "Ralph", tandemmaster: true, videospringer: true },
  { name: "Rene", tandemmaster: true, videospringer: false },
  { name: "Robert", tandemmaster: false, videospringer: true },
  { name: "Robin", tandemmaster: false, videospringer: true },
  { name: "Sabrina", tandemmaster: false, videospringer: true },
  { name: "Sahira", tandemmaster: true, videospringer: true },
  { name: "Samuel", tandemmaster: true, videospringer: true },
  { name: "Stefan", tandemmaster: true, videospringer: false },
  { name: "Steve", tandemmaster: true, videospringer: false },
  { name: "Tim", tandemmaster: true, videospringer: true },
  { name: "Tom", tandemmaster: true, videospringer: true },
  { name: "Torsten", tandemmaster: true, videospringer: true },
].sort((a, b) => a.name.localeCompare(b.name, "de"));

export function crewNamesForRole(
  list: CrewMember[] | undefined | null,
  role: "tandemmaster" | "videospringer",
): string[] {
  if (!list?.length) return [];
  return list
    .filter((c) => (role === "tandemmaster" ? c.tandemmaster : c.videospringer))
    .map((c) => c.name)
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => a.localeCompare(b, "de"));
}

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export type CreateVideoOptions = {
  dauer?: number;
  intro_enabled?: boolean;
  video_codec?: "auto" | "h264" | "h265";
  crf?: number;
  parallel_enabled?: boolean;
};

export type CreateVideoResult = {
  output: string;
  encoder: string;
  intro_created: boolean;
  body_clips: number;
};

export type CreateJobOptions = {
  watermark_clip_index?: number | null;
  watermark_photo_indices?: number[];
  dauer?: number;
  intro_enabled?: boolean;
  video_codec?: "auto" | "h264" | "h265";
  crf?: number;
  parallel_enabled?: boolean;
  /** Path from last matching `generate_preview` (backend verifies fingerprint). */
  reuse_preview_path?: string | null;
  reuse_preview_fingerprint?: string | null;
};

export type CreateJobResult = {
  base_output_dir: string;
  base_filename: string;
  video_output: string | null;
  watermark_video: string | null;
  photos_copied: number;
  watermark_photos: number;
  marker_path: string;
  encoder: string;
  intro_created: boolean;
  body_clips: number;
  reused_preview: boolean;
};

export type PreviewResult = {
  preview_path: string;
  work_dir: string;
  strategy: string;
  target_codec: string | null;
  encoder: string;
  intro_included: boolean;
  clip_count: number;
  fingerprint: string;
  /** Why clips were re-encoded; null/undefined when stream-copy only. */
  reencode_reason?: string | null;
};

export type CutResult = {
  output: string;
  method: string;
  overwritten: boolean;
  reencode_reason?: string | null;
};

export type SplitResult = {
  part1_path: string;
  part2_path: string;
  method: string;
  overwritten: boolean;
};

export type QrScanResult = {
  found: boolean;
  kunde: Kunde | null;
  source_path: string | null;
  cancelled: boolean;
  message: string;
};

export async function importVideos(paths: string[]): Promise<VideoMetadata[]> {
  return invoke<VideoMetadata[]>("import_videos", { paths });
}

/** Copy photos into the session working folder; returns destination paths. */
export async function importPhotos(paths: string[]): Promise<string[]> {
  return invoke<string[]>("import_photos", { paths });
}

export async function getWorkingDir(): Promise<string | null> {
  return invoke<string | null>("get_working_dir");
}

/** Delete the session working folder (imported media copies). */
export async function clearWorkingSession(): Promise<void> {
  return invoke("clear_working_session");
}

/** Delete one file if it belongs to the session working folder. */
export async function deleteWorkingCopy(path: string): Promise<boolean> {
  return invoke<boolean>("delete_working_copy", { path });
}

export async function probeVideo(path: string): Promise<VideoMetadata> {
  return invoke<VideoMetadata>("probe_video", { path });
}

export async function createVideo(
  kunde: Kunde,
  videoPaths: string[],
  output: string,
  options?: CreateVideoOptions,
): Promise<CreateVideoResult> {
  return invoke<CreateVideoResult>("create_video", {
    kunde,
    videoPaths,
    output,
    options: options ?? null,
  });
}

export async function validateCreateJob(
  kunde: Kunde,
  videoPaths: string[],
  photoPaths: string[],
  watermarkPhotoIndices?: number[],
  oldschoolMode?: boolean,
): Promise<ValidationResult> {
  return invoke<ValidationResult>("validate_create_job", {
    kunde,
    videoPaths,
    photoPaths,
    watermarkPhotoIndices: watermarkPhotoIndices ?? null,
    oldschoolMode: oldschoolMode ?? null,
  });
}

export async function createJob(
  kunde: Kunde,
  videoPaths: string[],
  photoPaths: string[],
  options?: CreateJobOptions,
): Promise<CreateJobResult> {
  return invoke<CreateJobResult>("create_job", {
    kunde,
    videoPaths,
    photoPaths,
    options: options ?? null,
  });
}

export async function generatePreview(
  videoPaths: string[],
  kunde: Kunde,
): Promise<PreviewResult> {
  return invoke<PreviewResult>("generate_preview", {
    videoPaths,
    kunde,
  });
}

/** Cut `[start, end)` seconds. With `overwrite` replaces the source file. */
export async function cutVideo(opts: {
  input: string;
  start: number;
  end: number;
  output?: string | null;
  overwrite?: boolean;
  precise?: boolean;
}): Promise<CutResult> {
  return invoke<CutResult>("cut_video", {
    input: opts.input,
    start: opts.start,
    end: opts.end,
    output: opts.output ?? null,
    overwrite: opts.overwrite ?? false,
    precise: opts.precise ?? false,
  });
}

/** Split at `splitSecs`. With `overwrite` writes `name_1` / `name_2`. */
export async function splitVideo(opts: {
  input: string;
  splitSecs: number;
  part1Path?: string | null;
  part2Path?: string | null;
  overwrite?: boolean;
}): Promise<SplitResult> {
  return invoke<SplitResult>("split_video", {
    input: opts.input,
    splitSecs: opts.splitSecs,
    part1Path: opts.part1Path ?? null,
    part2Path: opts.part2Path ?? null,
    overwrite: opts.overwrite ?? false,
  });
}

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  return invoke<AppConfig>("save_config", { config });
}

export async function validateKunde(
  kunde: Kunde,
  videoPaths: string[] = [],
  oldschoolMode?: boolean,
): Promise<ValidationResult> {
  return invoke<ValidationResult>("validate_kunde", {
    kunde,
    videoPaths,
    oldschoolMode: oldschoolMode ?? null,
  });
}

export async function scanQrVideo(path: string): Promise<QrScanResult> {
  return invoke<QrScanResult>("scan_qr_video", { path });
}

export async function scanQrPhoto(path: string): Promise<QrScanResult> {
  return invoke<QrScanResult>("scan_qr_photo", { path });
}

export async function scanQrVideos(paths: string[]): Promise<QrScanResult> {
  return invoke<QrScanResult>("scan_qr_videos", { paths });
}

export async function scanQrPhotos(paths: string[]): Promise<QrScanResult> {
  return invoke<QrScanResult>("scan_qr_photos", { paths });
}

/** Expand files + folders into a flat media path list (recursive for directories). */
export async function expandMediaPaths(paths: string[]): Promise<string[]> {
  return invoke<string[]>("expand_media_paths", { paths });
}

export type FileSizeEntry = {
  path: string;
  size_bytes: number;
};

export async function getFileSizes(paths: string[]): Promise<FileSizeEntry[]> {
  if (paths.length === 0) return [];
  return invoke<FileSizeEntry[]>("get_file_sizes", { paths });
}

export type ConnectionTestResult = {
  ok: boolean;
  message: string;
};

export type UploadResult = {
  success: boolean;
  message: string;
  remote_path: string;
};

export type UploadProgressEvent = {
  percent: number;
  current_file: number;
  total_files: number;
  current_bytes: number;
  total_bytes: number;
  filename: string;
  status: string;
};

export type ServerOverrides = {
  server_url?: string;
  server_login?: string;
  server_password?: string;
};

export type UpdaterStatus = {
  configured: boolean;
  current_version: string;
  message: string;
};

export type UpdateCheckResult = {
  configured: boolean;
  available: boolean;
  current_version: string;
  latest_version: string | null;
  body: string | null;
  message: string;
};

export async function testServerConnection(
  overrides?: ServerOverrides,
): Promise<ConnectionTestResult> {
  return invoke<ConnectionTestResult>("test_server_connection", {
    overrides: overrides ?? null,
  });
}

export async function uploadToServer(
  localPath: string,
  overrides?: ServerOverrides,
): Promise<UploadResult> {
  return invoke<UploadResult>("upload_to_server", {
    localPath,
    overrides: overrides ?? null,
  });
}

export async function getUpdaterStatus(): Promise<UpdaterStatus> {
  return invoke<UpdaterStatus>("get_updater_status");
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates");
}

export async function installUpdate(): Promise<string> {
  return invoke<string>("install_update");
}

export type AppInfo = {
  product_name: string;
  version: string;
  log_path: string | null;
  config_dir: string | null;
};

export type HwAccelInfo = {
  available: boolean;
  hw_type: string;
  encoder: string;
  hwaccel?: string | null;
  extra_params?: string[];
};

export type CacheCleanupResult = {
  deleted_dirs: string[];
  deleted_files: string[];
  errors: string[];
  bytes_freed: number;
  summary: string;
};

export type StartupCheckResult = {
  ok: boolean;
  ffmpeg_path: string | null;
  ffmpeg_error: string | null;
  hw: HwAccelInfo | null;
  cache: CacheCleanupResult | null;
  version: string;
  message: string;
};

export type CleanupCacheArgs = {
  speicherort?: string | null;
  import_paths?: string[] | null;
  exclude_temp_dir?: string | null;
  include_hw_cache?: boolean | null;
  orphans_only?: boolean | null;
};

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export async function runStartupChecks(
  autoCleanup = true,
): Promise<StartupCheckResult> {
  return invoke<StartupCheckResult>("run_startup_checks", {
    autoCleanup,
  });
}

export async function cleanupCache(
  args?: CleanupCacheArgs,
): Promise<CacheCleanupResult> {
  return invoke<CacheCleanupResult>("cleanup_cache", {
    args: args ?? null,
  });
}
