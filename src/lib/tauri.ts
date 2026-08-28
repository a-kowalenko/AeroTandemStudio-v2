/** Shared types and typed Tauri invoke wrappers. */

import { invoke } from "@tauri-apps/api/core";
import { tr } from "@/i18n";

export type VideoMetadata = {
  path: string;
  filename: string;
  duration_secs: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  size_bytes: number;
  /** Camera brand from container metadata (empty if unknown). */
  camera_make?: string;
  /** Camera model from container metadata (empty if unknown). */
  camera_model?: string;
};

export type PhotoMetadata = {
  path: string;
  filename: string;
  size_bytes: number;
  width: number;
  height: number;
  /** Camera brand from EXIF Make (empty if unknown). */
  camera_make?: string;
  /** Camera model from EXIF Model (empty if unknown). */
  camera_model?: string;
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

export type ServerProfile = {
  id: string;
  label: string;
  url: string;
  login: string;
  password: string;
  /** Optional secondary SMB target for this profile. */
  backup_url: string;
  backup_login: string;
  backup_password: string;
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
  /**
   * Current operator ("Ich"). Roles come from the matching crew_list entry.
   * Empty = no favorite pin in TM/VS form comboboxes.
   */
  operator_name: string;
  /** Editable crew roster; roles filter form combobox suggestions. */
  crew_list: CrewMember[];
  /**
   * Intentionally removed crew names (tombstones).
   * Default-roster merge skips these so deletions survive app updates.
   */
  crew_removed_names: string[];
  upload_to_server: boolean;
  /** Saved SMB profiles; active entry mirrors flat server_* fields. */
  server_profiles: ServerProfile[];
  active_server_profile_id: string;
  server_url: string;
  server_login: string;
  server_password: string;
  hardware_acceleration_enabled: boolean;
  parallel_processing_enabled: boolean;
  video_codec: string;
  encoding_strategy: string;
  reencode_matching_clips: boolean;
  /** Intro+Body mux: "reencode" (default) | "stream_copy". */
  intro_mux_mode: "stream_copy" | "reencode" | string;
  /** Multi-clip body concat: "fast" (default) | "legacy". */
  body_concat_mode: "legacy" | "fast" | string;
  preview_encode_crf: number;
  qr_check_enabled: boolean;
  photo_qr_check_enabled: boolean;
  qr_video_scan_seconds: number;
  qr_remove_photo_after_scan: boolean;
  qr_remove_video_after_scan: boolean;
  qr_remove_video_max_duration_sec: number;
  sd_auto_backup: boolean;
  sd_backup_folder: string;
  /** Optional SMB mirror of local SD backups. */
  sd_server_backup_enabled: boolean;
  /** smb://host/share[/sub…] (UNC / local path fallback like upload). */
  sd_server_backup_url: string;
  /** "local_then_server" | "local_then_server_async" (legacy direct_dual_write → async) */
  sd_server_backup_mode: string;
  sd_backup_mode: string;
  /** Label in backup folder names; empty uses hostname when opening settings. */
  sd_pc_name: string;
  sd_clear_after_backup: boolean;
  /** Eject after backup (before import/QR), or after import when no backup ran. */
  sd_eject_after_workflow: boolean;
  sd_auto_import: boolean;
  sd_skip_processed: boolean;
  sd_size_limit_enabled: boolean;
  sd_size_limit_mb: number;
  /** USB action cams (GoPro/DJI/Insta360) via MTP/WPD. */
  usb_camera_import_enabled: boolean;
  /** "auto" | "volume_only" | "mtp_preferred" */
  usb_import_mode: string;
  oldschool_mode: boolean;
  /** Manual entry when not QR: "id" | "oldschool" | "lokal". */
  manual_entry_mode: ManualEntryMode;
  keep_tandemmaster_on_session_reset: boolean;
  keep_videospringer_on_session_reset: boolean;
  /** Clear imported media and session form after successful create. */
  auto_clear_files_after_creation: boolean;
  /** First-run setup wizard finished or skipped. */
  setup_completed: boolean;
  /** UI language: "de" | "en" | "es-MX". */
  ui_language: string;
  /** Include GitHub prerelease (beta) builds in auto-update checks. */
  beta_updates_enabled: boolean;
  /** Min log level for file + console IPC: "debug" | "info" | "warn" | "error". */
  log_min_level: string;
  /** Optional AMS LAN Bridge base URL (`http://host:8787`). */
  ams_bridge_url: string;
  /** Shared bearer token for AMS Bridge. */
  ams_bridge_token: string;
  /** Stable ATS instance UUID for AMS Bridge presence / host attribution. */
  ams_bridge_instance_id: string;
  /** Last Bridge URL that answered health OK. */
  ams_bridge_last_ok_url: string;
  /** Display name of the connected AMS server. */
  ams_bridge_display_name: string;
  /** Stable UUID of the connected AMS server. */
  ams_bridge_server_instance_id: string;
};

/** Fixed Ort presets; free text remains allowed in the combobox.
 *  Folder suffixes are assigned in Rust (`DROPZONE_SUFFIXES`): Calden=`_C`, Gera=`_G`. */
export const ORT_OPTIONS = ["Calden", "Gera"] as const;

/** Manual customer form mode (non-QR). */
export type ManualEntryMode = "id" | "oldschool" | "lokal";

export function normalizeManualEntryMode(
  mode: string | null | undefined,
  oldschoolFallback = false,
): ManualEntryMode {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "oldschool") return "oldschool";
  if (m === "lokal") return "lokal";
  if (m === "id") return "id";
  return oldschoolFallback ? "oldschool" : "id";
}

export function withManualEntryMode(
  config: AppConfig,
  mode: ManualEntryMode,
): AppConfig {
  return {
    ...config,
    manual_entry_mode: mode,
    oldschool_mode: mode === "oldschool",
  };
}

/** Combobox sentinel: do not keep role on session reset. */
export const CREW_KEEP_OFF_VALUE = "__keep_off__";
/** Combobox sentinel: keep last form value on session reset. */
export const CREW_KEEP_LAST_VALUE = "__keep_last__";

export type CrewKeepPinnedOption = { value: string; label: string };

/** Leading options for TM/VS keep dropdown (Settings / Setup). */
export function getCrewKeepPinnedOptions(): readonly CrewKeepPinnedOption[] {
  return [
    { value: CREW_KEEP_OFF_VALUE, label: tr("settings.crew.keep.off") },
    { value: CREW_KEEP_LAST_VALUE, label: tr("settings.crew.keep.last") },
  ];
}
/** @deprecated Use getCrewKeepPinnedOptions() for translated labels. */
export const CREW_KEEP_PINNED_OPTIONS: readonly CrewKeepPinnedOption[] = [
  { value: CREW_KEEP_OFF_VALUE, label: "Nicht beibehalten" },
  { value: CREW_KEEP_LAST_VALUE, label: "Zuletzt verwendeten beibehalten" },
];

/** Map config keep flag + stored name → combobox value. */
export function crewKeepComboboxValue(keep: boolean, name: string): string {
  if (!keep) return CREW_KEEP_OFF_VALUE;
  const n = name.trim();
  if (!n) return CREW_KEEP_LAST_VALUE;
  return n;
}

/** Map combobox value → config keep flag + stored name. */
export function parseCrewKeepComboboxValue(raw: string): {
  keep: boolean;
  name: string;
} {
  const v = raw.trim();
  if (!v || v === CREW_KEEP_OFF_VALUE || v === "Nicht beibehalten") {
    return { keep: false, name: "" };
  }
  if (
    v === CREW_KEEP_LAST_VALUE ||
    v === "Zuletzt verwendeten beibehalten"
  ) {
    return { keep: true, name: "" };
  }
  return { keep: true, name: v };
}

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
  { name: "Jojo", tandemmaster: false, videospringer: true },
  { name: "Kai", tandemmaster: false, videospringer: true },
  { name: "Käthe", tandemmaster: false, videospringer: true },
  { name: "Max", tandemmaster: true, videospringer: false },
  { name: "Mathi", tandemmaster: false, videospringer: true },
  { name: "Mayo", tandemmaster: true, videospringer: true },
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

/** Case-insensitive crew name equality (trimmed). */
export function crewNamesEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = (a ?? "").trim().toLowerCase();
  const right = (b ?? "").trim().toLowerCase();
  return Boolean(left) && left === right;
}

export function findCrewMember(
  list: CrewMember[] | undefined | null,
  name: string | null | undefined,
): CrewMember | undefined {
  const needle = (name ?? "").trim().toLowerCase();
  if (!needle || !list?.length) return undefined;
  return list.find((c) => c.name.trim().toLowerCase() === needle);
}

/** Canonical display name from crew list, or trimmed input if unknown. */
export function canonicalCrewName(
  list: CrewMember[] | undefined | null,
  name: string | null | undefined,
): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return findCrewMember(list, trimmed)?.name.trim() || trimmed;
}

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

/** All crew display names (any role), sorted. */
export function crewAllNames(
  list: CrewMember[] | undefined | null,
): string[] {
  if (!list?.length) return [];
  return [
    ...new Set(
      list
        .map((c) => c.name.trim())
        .filter((n) => n.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b, "de"));
}

export type CrewPinnedOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type CrewPinnedEntry =
  | CrewPinnedOption
  | { kind: "separator" };

/**
 * Favorite pin for form TM/VS comboboxes: only when operator matches a
 * crew member that has the given role. Label uses "{Name} (Ich)".
 */
export function crewPinnedSelfOption(
  list: CrewMember[] | undefined | null,
  role: "tandemmaster" | "videospringer",
  operatorName: string | null | undefined,
  opts?: { disabled?: boolean },
): CrewPinnedOption | null {
  const member = findCrewMember(list, operatorName);
  if (!member) return null;
  const hasRole =
    role === "tandemmaster" ? member.tandemmaster : member.videospringer;
  if (!hasRole) return null;
  const value = member.name.trim();
  if (!value) return null;
  return {
    value,
    label: `${value} (${tr("settings.crew.keep.selfSuffix")})`,
    disabled: Boolean(opts?.disabled),
  };
}

/**
 * Keep-mode pins + optional „Ich“ pin (with divider) when operator has the role.
 */
export function crewKeepPinnedOptions(
  list: CrewMember[] | undefined | null,
  role: "tandemmaster" | "videospringer",
  operatorName: string | null | undefined,
): readonly CrewPinnedEntry[] {
  const self = crewPinnedSelfOption(list, role, operatorName);
  const pinned = getCrewKeepPinnedOptions();
  if (!self) return pinned;
  return [...pinned, { kind: "separator" }, self];
}

/**
 * Insert or update a crew member with explicit roles.
 * No-op when both roles are false (caller validates "at least one").
 */
export function upsertCrewMember(
  list: CrewMember[],
  name: string,
  roles: { tandemmaster: boolean; videospringer: boolean },
): CrewMember[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  if (!roles.tandemmaster && !roles.videospringer) return list;
  const idx = list.findIndex(
    (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (idx >= 0) {
    const next = [...list];
    const prev = next[idx];
    next[idx] = {
      ...prev,
      name: prev.name.trim() || trimmed,
      tandemmaster: roles.tandemmaster,
      videospringer: roles.videospringer,
    };
    return next;
  }
  return [
    ...list,
    {
      name: trimmed,
      tandemmaster: roles.tandemmaster,
      videospringer: roles.videospringer,
    },
  ].sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** Record an intentional crew deletion so default-merge will not re-add the name. */
export function markCrewRemovedName(
  removed: string[] | undefined | null,
  name: string,
): string[] {
  const trimmed = name.trim();
  const list = [...(removed ?? [])];
  if (!trimmed) return list;
  if (list.some((n) => crewNamesEqual(n, trimmed))) return list;
  list.push(trimmed);
  return list;
}

/** Clear a tombstone when the user re-adds the name manually. */
export function clearCrewRemovedName(
  removed: string[] | undefined | null,
  name: string,
): string[] {
  const trimmed = name.trim();
  const list = [...(removed ?? [])];
  if (!trimmed || list.length === 0) return list;
  return list.filter((n) => !crewNamesEqual(n, trimmed));
}

/**
 * Drop tombstones for every name currently present in the crew list
 * (safety net after upsert / ensure / wizard).
 */
export function syncCrewRemovedNames(
  removed: string[] | undefined | null,
  list: CrewMember[],
): string[] {
  const tombstones = [...(removed ?? [])];
  if (tombstones.length === 0) return tombstones;
  return tombstones.filter(
    (n) => !list.some((c) => crewNamesEqual(c.name, n)),
  );
}

/**
 * Ensure `name` exists in the crew list. Existing entries are left unchanged.
 * Missing names are added only when `roles` has at least one role set.
 */
export function ensureCrewMember(
  list: CrewMember[],
  name: string,
  roles?: { tandemmaster: boolean; videospringer: boolean },
): CrewMember[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  if (findCrewMember(list, trimmed)) return list;
  if (!roles || (!roles.tandemmaster && !roles.videospringer)) return list;
  return upsertCrewMember(list, trimmed, roles);
}

/** Sync operator_name when a crew member is renamed or removed. */
export function syncOperatorName(
  operatorName: string,
  prevName: string,
  nextName: string | null,
): string {
  if (!crewNamesEqual(operatorName, prevName)) return operatorName;
  return (nextName ?? "").trim();
}

/** Add or update a crew member so `name` has the given role (creates if missing). */
export function ensureCrewRole(
  list: CrewMember[],
  name: string,
  role: "tandemmaster" | "videospringer",
): CrewMember[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  const idx = list.findIndex(
    (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (idx >= 0) {
    const next = [...list];
    const prev = next[idx];
    next[idx] = {
      ...prev,
      name: prev.name.trim() || trimmed,
      [role]: true,
    };
    return next;
  }
  return [
    ...list,
    {
      name: trimmed,
      tandemmaster: role === "tandemmaster",
      videospringer: role === "videospringer",
    },
  ].sort((a, b) => a.name.localeCompare(b.name, "de"));
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
  /** Intro+Body mux: "stream_copy" | "reencode". */
  intro_mux_mode?: "stream_copy" | "reencode" | string;
  /** Multi-clip body concat: "legacy" | "fast". */
  body_concat_mode?: "legacy" | "fast" | string;
  /** Use NVENC/VideoToolbox when available. */
  hw_accel_enabled?: boolean;
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
  /** Intro+Body mux: "stream_copy" | "reencode". */
  intro_mux_mode?: "stream_copy" | "reencode" | string;
  /** Multi-clip body concat: "legacy" | "fast". */
  body_concat_mode?: "legacy" | "fast" | string;
  /** Use NVENC/VideoToolbox when available. */
  hw_accel_enabled?: boolean;
  /** Path from last matching `generate_preview` (backend verifies fingerprint). */
  reuse_preview_path?: string | null;
  reuse_preview_fingerprint?: string | null;
  /** After folder-conflict confirm: wipe job folder before writing. */
  replace_existing_dir?: boolean;
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
  correlation_id: string;
  /** History row id after create (null if history write failed). */
  vorgang_id?: number | null;
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

export type QrSpotlight = {
  x: number;
  y: number;
  size: number;
};

export type QrPreview = {
  path: string;
  width: number;
  height: number;
  spotlight: QrSpotlight | null;
};

export type CleanupDirection = "forward" | "backward";

export type QrScanResult = {
  found: boolean;
  kunde: Kunde | null;
  source_path: string | null;
  cancelled: boolean;
  message: string;
  preview: QrPreview | null;
  /** From parallel worker: reverse quarter → backward series cleanup. */
  cleanup_direction?: CleanupDirection | null;
};

export async function importVideos(paths: string[]): Promise<VideoMetadata[]> {
  return invoke<VideoMetadata[]>("import_videos", { paths });
}

/** Copy photos into the session working folder; returns metadata (path + camera). */
export async function importPhotos(paths: string[]): Promise<PhotoMetadata[]> {
  return invoke<PhotoMetadata[]>("import_photos", { paths });
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

/** Batch-delete working copies (blocking pool; keeps UI responsive). */
export async function deleteWorkingCopies(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  return invoke<number>("delete_working_copies", { paths });
}

/** Loopback HTTP URL for HTML5 video playback (Range-capable). */
export async function mediaFileUrl(path: string): Promise<string> {
  return invoke<string>("media_file_url", { path });
}

export async function probeVideo(path: string): Promise<VideoMetadata> {
  return invoke<VideoMetadata>("probe_video", { path });
}

/** Keyframe timestamps in seconds (for trim snapping / stream-copy). */
export async function listVideoKeyframes(
  path: string,
  durationSecs?: number | null,
): Promise<number[]> {
  return invoke<number[]>("list_video_keyframes", {
    path,
    durationSecs: durationSecs ?? null,
  });
}

/** Evenly spaced filmstrip frame URLs (HTTP media server) for Apple-style trim UI. */
export async function getVideoFilmstrip(
  path: string,
  count = 14,
  height = 56,
  durationSecs?: number | null,
): Promise<string[]> {
  return invoke<string[]>("get_video_filmstrip", {
    path,
    count,
    height,
    durationSecs: durationSecs ?? null,
  });
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

export type OutputFolderProbe = {
  exists: boolean;
  is_empty: boolean;
  folder_name: string;
  folder_path: string;
  has_marker: boolean;
  video_file_count: number;
  photo_file_count: number;
  other_file_count: number;
  total_file_count: number;
};

/** Read-only: planned create folder already has files? */
export async function probeCreateOutputFolder(
  kunde: Kunde,
): Promise<OutputFolderProbe> {
  return invoke<OutputFolderProbe>("probe_create_output_folder", { kunde });
}

export async function createJob(
  kunde: Kunde,
  videoPaths: string[],
  photoPaths: string[],
  options?: CreateJobOptions,
  /** QR hit-frame for Vorgang history (QR mode only). */
  qrPreview?: QrPreview | null,
): Promise<CreateJobResult> {
  return invoke<CreateJobResult>("create_job", {
    kunde,
    videoPaths,
    photoPaths,
    options: options ?? null,
    qrPreview: qrPreview ?? null,
  });
}

/** Resolve Intro+Body stream-copy fallback dialog (`without_intro` | `with_intro_encode`). */
export async function resolveIntroMuxFallback(
  choice: "without_intro" | "with_intro_encode",
): Promise<void> {
  return invoke("resolve_intro_mux_fallback", { choice });
}

export type IntroMuxFallbackPayload = {
  reason: string;
  timeout_secs: number;
};

export async function resolveBodyConcatFallback(
  choice: "abort" | "use_legacy" | string,
): Promise<void> {
  return invoke("resolve_body_concat_fallback", { choice });
}

export type BodyConcatFallbackPayload = {
  reason: string;
};

/** Resolve re-encode confirmation (`proceed` | `abort`) with optional encode profile. */
export async function resolveReencodeConfirm(
  choice: "proceed" | "abort" | string,
  profile?: EncodeProfile | null,
): Promise<void> {
  return invoke("resolve_reencode_confirm", { choice, profile: profile ?? null });
}

export type EncodePresetId =
  | "recommended"
  | "max_quality"
  | "balanced"
  | "fast"
  | "compat"
  | "custom";

export type EncodeProfile = {
  preset_id: EncodePresetId;
  codec: string;
  /** Concrete codec when `codec` is `auto` (`h264` | `h265`). */
  resolved_codec?: string | null;
  crf: number;
  sw_preset: string;
  nvenc_preset: string;
  hw_accel: boolean;
  scale_mode: "source" | "fit_1080p";
  fps_mode: "source" | "force_30";
  recommend_reason?: string | null;
};

export type ReencodeConfirmPayload = {
  kind: string;
  reason: string;
  params: {
    encoder?: string | null;
    target_codec?: string | null;
    crf?: number | null;
    hw_accel?: boolean | null;
    clip_count?: number | null;
    intro_duration_secs?: number | null;
    intro_mux_mode?: string | null;
    strategy?: string | null;
    degrees?: number | null;
    details?: string[] | null;
  };
  recommended: EncodeProfile;
  presets: string[];
};

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

/** Rotate video by 90° steps (re-encode). With `overwrite` replaces the source. */
export async function rotateVideo(opts: {
  input: string;
  degrees: number;
  output?: string | null;
  overwrite?: boolean;
}): Promise<CutResult> {
  return invoke<CutResult>("rotate_video", {
    input: opts.input,
    degrees: opts.degrees,
    output: opts.output ?? null,
    overwrite: opts.overwrite ?? false,
  });
}

export type PhotoRotateResult = {
  output: string;
  degrees: number;
  overwritten: boolean;
  width: number;
  height: number;
};

export async function rotatePhoto(opts: {
  input: string;
  degrees: number;
  output?: string | null;
  overwrite?: boolean;
}): Promise<PhotoRotateResult> {
  return invoke<PhotoRotateResult>("rotate_photo", {
    input: opts.input,
    degrees: opts.degrees,
    output: opts.output ?? null,
    overwrite: opts.overwrite ?? true,
  });
}

export type PhotoCropResult = {
  output: string;
  overwritten: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
};

export async function cropPhoto(opts: {
  input: string;
  x: number;
  y: number;
  w: number;
  h: number;
  output?: string | null;
  overwrite?: boolean;
}): Promise<PhotoCropResult> {
  return invoke<PhotoCropResult>("crop_photo", {
    input: opts.input,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    output: opts.output ?? null,
    overwrite: opts.overwrite ?? true,
  });
}

export type UndoPhotoEditResult = {
  restore_path: string;
};

export async function undoPhotoEditForPath(
  path: string,
): Promise<UndoPhotoEditResult> {
  return invoke<UndoPhotoEditResult>("undo_photo_edit_for_path", { path });
}

export async function hasPhotoEditUndo(): Promise<boolean> {
  return invoke<boolean>("has_photo_edit_undo");
}

export async function listPhotoEditMarks(): Promise<string[]> {
  return invoke<string[]>("list_photo_edit_marks");
}

export async function clearPhotoEditUndo(): Promise<void> {
  return invoke("clear_photo_edit_undo");
}

export async function discardPhotoEditUndoForPath(path: string): Promise<void> {
  return invoke("discard_photo_edit_undo_for_path", { path });
}

export type UndoCutResult = {
  kind: string;
  restore_path: string;
  removed_paths: string[];
  cleared_mark_paths: string[];
};

export async function undoLastVideoCut(): Promise<UndoCutResult> {
  return invoke<UndoCutResult>("undo_last_video_cut");
}

export async function undoVideoCutForPath(path: string): Promise<UndoCutResult> {
  return invoke<UndoCutResult>("undo_video_cut_for_path", { path });
}

export async function undoAllVideoCuts(): Promise<UndoCutResult[]> {
  return invoke<UndoCutResult[]>("undo_all_video_cuts");
}

export async function hasVideoCutUndo(): Promise<boolean> {
  return invoke<boolean>("has_video_cut_undo");
}

export async function listVideoCutMarks(): Promise<string[]> {
  return invoke<string[]>("list_video_cut_marks");
}

export async function clearVideoCutUndo(): Promise<void> {
  return invoke("clear_video_cut_undo");
}

export async function discardVideoCutUndoForPath(path: string): Promise<void> {
  return invoke("discard_video_cut_undo_for_path", { path });
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

export async function resetConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("reset_config");
}

export type DefaultMediaDirKind = "speicherort" | "sd_backup_folder";

export type DefaultMediaDirsProposal = {
  root: string;
  speicherort: string;
  sd_backup_folder: string;
  speicherort_exists: boolean;
  sd_backup_folder_exists: boolean;
  warnings: string[];
  alternate_root: string | null;
  alternate_speicherort: string | null;
  alternate_sd_backup_folder: string | null;
  free_bytes: number | null;
  alternate_free_bytes: number | null;
};

export type EnsureDefaultMediaDirResult = {
  kind: DefaultMediaDirKind;
  root: string;
  path: string;
  created: boolean;
  warnings: string[];
};

export async function proposeDefaultMediaDirs(): Promise<DefaultMediaDirsProposal> {
  return invoke<DefaultMediaDirsProposal>("propose_default_media_dirs");
}

export async function ensureDefaultMediaDir(
  kind: DefaultMediaDirKind,
  root?: string | null,
): Promise<EnsureDefaultMediaDirResult> {
  return invoke<EnsureDefaultMediaDirResult>("ensure_default_media_dir", {
    kind,
    root: root?.trim() ? root : null,
  });
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

/** Bidirectional same-series follow-up; returns paths that also contain a QR. */
export async function scanQrPhotoFollowups(
  orderedPaths: string[],
  hitPath: string,
): Promise<string[]> {
  return invoke<string[]>("scan_qr_photo_followups", {
    orderedPaths,
    hitPath,
  });
}

/** Remove a QR hit-frame preview temp file/dir after the success dialog closes. */
export async function discardQrPreview(path: string): Promise<void> {
  if (!path.trim()) return;
  await invoke("discard_qr_preview_file", { path });
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
  /** Present when a staged SMB upload did not promote to the final job folder. */
  staging_root?: string | null;
};

export type UploadProgressEvent = {
  percent: number;
  /** Files fully uploaded so far (0…total_files); not a parallel worker slot. */
  current_file: number;
  total_files: number;
  current_bytes: number;
  total_bytes: number;
  /** Average throughput since upload start (bytes per second). */
  speed_bps: number;
  /** Optional basename; UI should not treat as “current file”. */
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
  prerelease: boolean;
  updater_json_url: string | null;
  installer_url: string | null;
};

export type UpdateInstallProgress = {
  phase: "download" | "install" | string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number;
  speedBps: number;
};

export type AvailableRelease = {
  tag_name: string;
  published_at: string;
  body: string;
  installer_url: string | null;
  updater_json_url: string | null;
  prerelease: boolean;
};

export async function testServerConnection(
  overrides?: ServerOverrides,
): Promise<ConnectionTestResult> {
  return invoke<ConnectionTestResult>("test_server_connection", {
    overrides: overrides ?? null,
  });
}

export type AmsBridgeAtsPaths = {
  primary_smb_url: string;
  backup_smb_url?: string;
};

export type AmsBridgeHealth = {
  online: boolean;
  version: string;
  display_name?: string;
  instance_id?: string;
  monitor_path: string;
  ats_paths?: AmsBridgeAtsPaths | null;
  capabilities: string[];
};

export type AmsBridgeHealthResult = {
  ok: boolean;
  message: string;
  health: AmsBridgeHealth | null;
  base_url: string;
};

export type AmsBridgeHealthOverrides = {
  baseUrl?: string;
  token?: string;
};

export type AmsBridgeLookupResponse = {
  ok: boolean;
  customer?: AmsBridgeCustomer | null;
  error?: { code: string; message: string } | null;
};

export type AmsBridgeCustomer = {
  customer_number?: string | null;
  booking_number?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
  handcam_foto?: boolean;
  handcam_video?: boolean;
  outside_foto?: boolean;
  outside_video?: boolean;
  ist_bezahlt_handcam_foto?: boolean;
  ist_bezahlt_handcam_video?: boolean;
  ist_bezahlt_outside_foto?: boolean;
  ist_bezahlt_outside_video?: boolean;
};

export async function amsBridgeHealth(
  overrides?: AmsBridgeHealthOverrides,
): Promise<AmsBridgeHealthResult> {
  return invoke<AmsBridgeHealthResult>("ams_bridge_health", {
    overrides: overrides
      ? {
          baseUrl: overrides.baseUrl ?? null,
          token: overrides.token ?? null,
        }
      : null,
  });
}

export async function amsBridgeCustomerLookup(args: {
  customerId: string;
  bookingId: string;
  markerType: string;
  mode?: string;
}): Promise<AmsBridgeLookupResponse> {
  return invoke<AmsBridgeLookupResponse>("ams_bridge_customer_lookup", {
    customerId: args.customerId,
    bookingId: args.bookingId,
    markerType: args.markerType,
    mode: args.mode ?? null,
  });
}

export type AmsBridgeJobStatus = {
  schema: number;
  correlation_id: string;
  updated_at: string;
  state: string;
  error?: { code: string; message: string } | null;
  ams?: { history_id?: string | null; archive?: string | null };
};

export type AmsBridgeHandoffReadyResult = {
  ok: boolean;
  woken: boolean;
  error?: { code: string; message: string } | null;
};

export async function amsBridgeJobStatus(
  correlationId: string,
): Promise<AmsBridgeJobStatus | null> {
  return invoke<AmsBridgeJobStatus | null>("ams_bridge_job_status", {
    correlationId,
  });
}

export async function amsBridgeHandoffReady(
  correlationId: string,
  folderName?: string,
): Promise<AmsBridgeHandoffReadyResult> {
  return invoke<AmsBridgeHandoffReadyResult>("ams_bridge_handoff_ready", {
    correlationId,
    folderName: folderName ?? null,
  });
}

export type AmsBridgeDiscovered = {
  instance: string;
  display_name: string;
  instance_id: string;
  host: string;
  port: number;
  base_url: string;
  version: string;
  capabilities: string[];
  monitor_path: string;
};

export async function amsBridgeDiscover(
  timeoutSecs?: number,
): Promise<AmsBridgeDiscovered[]> {
  return invoke<AmsBridgeDiscovered[]>("ams_bridge_discover", {
    timeoutSecs: timeoutSecs ?? null,
  });
}

export async function cancelEncode(): Promise<boolean> {
  return invoke<boolean>("cancel_encode");
}

/** Cancel Vorgang/Historie SMB upload only (does not abort SD server-backup). */
export async function cancelUploadSlot(): Promise<boolean> {
  return invoke<boolean>("cancel_upload_slot");
}

/** Cancel SD server-backup mirror only (does not abort Vorgang upload). */
export async function cancelSecondaryBackup(): Promise<boolean> {
  return invoke<boolean>("cancel_secondary_backup");
}

export async function resetWorkflowCancel(): Promise<void> {
  await invoke("reset_workflow_cancel");
}

export async function resetUploadSlotCancel(): Promise<void> {
  await invoke("reset_upload_slot_cancel");
}

export type HandoffUploadContext = {
  correlation_id?: string | null;
  folder_name?: string | null;
};

export async function uploadToServer(
  localPath: string,
  overrides?: ServerOverrides,
  handoff?: HandoffUploadContext | null,
): Promise<UploadResult> {
  return invoke<UploadResult>("upload_to_server", {
    localPath,
    overrides: overrides ?? null,
    handoff: handoff ?? null,
  });
}

export async function getUpdaterStatus(): Promise<UpdaterStatus> {
  return invoke<UpdaterStatus>("get_updater_status");
}

export async function getUpdaterInstallHint(): Promise<string | null> {
  return invoke<string | null>("get_updater_install_hint");
}

export async function checkForUpdates(
  includeBeta = false,
): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates", { includeBeta });
}

export async function installUpdate(): Promise<string> {
  return invoke<string>("install_update");
}

export async function cancelUpdateInstall(): Promise<boolean> {
  return invoke<boolean>("cancel_update_install");
}

export async function listAvailableVersions(): Promise<AvailableRelease[]> {
  return invoke<AvailableRelease[]>("list_available_versions");
}

export async function installSpecificVersion(updaterJsonUrl: string): Promise<string> {
  return invoke<string>("install_specific_version", { updaterJsonUrl });
}

export type AppInfo = {
  product_name: string;
  version: string;
  log_path: string | null;
  config_dir: string | null;
  computer_name: string;
};

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogEntry = {
  id: number;
  ts: string;
  level: string;
  source: string;
  message: string;
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

export type CacheUsageResult = {
  bytes: number;
  dirs: number;
  files: number;
};

export type LocalFolderClearProbe = {
  root: string;
  root_exists: boolean;
  folder_count: number;
  file_count: number;
  history_folder_count: number;
  orphan_folder_count: number;
  bytes: number;
  retryable_upload_count: number;
};

export type ClearLocalJobFoldersArgs = {
  speicherort?: string | null;
  include_orphans?: boolean | null;
};

export type ClearLocalBackupFoldersArgs = {
  sd_backup_folder?: string | null;
};

export type StartupCheckResult = {
  ok: boolean;
  ffmpeg_path: string | null;
  ffmpeg_error: string | null;
  hw: HwAccelInfo | null;
  cache: CacheCleanupResult | null;
  version: string;
  message: string;
  /** Linux: missing GStreamer codecs → HTML5 video will not play. */
  media_warning: string | null;
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

export async function getRecentLogs(limit?: number): Promise<LogEntry[]> {
  return invoke<LogEntry[]>("get_recent_logs", { limit: limit ?? null });
}

export async function getLogMinLevel(): Promise<string> {
  return invoke<string>("get_log_min_level");
}

export async function setLogMinLevel(level: string): Promise<string> {
  return invoke<string>("set_log_min_level", { level });
}

export async function clearLogBuffer(): Promise<void> {
  return invoke<void>("clear_log_buffer");
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

/** Measure cache/temp footprint (same targets as full cleanup; no deletes). */
export async function measureCache(
  args?: CleanupCacheArgs,
): Promise<CacheUsageResult> {
  return invoke<CacheUsageResult>("measure_cache", {
    args: args ?? null,
  });
}

/** Probe local Vorgang folders under speicherort (history kept). */
export async function probeClearLocalJobFolders(
  args?: ClearLocalJobFoldersArgs,
): Promise<LocalFolderClearProbe> {
  return invoke<LocalFolderClearProbe>("probe_clear_local_job_folders", {
    args: args ?? null,
  });
}

/** Delete local Vorgang folders; vorgang_history DB unchanged. */
export async function clearLocalJobFolders(
  args?: ClearLocalJobFoldersArgs,
): Promise<CacheCleanupResult> {
  return invoke<CacheCleanupResult>("clear_local_job_folders", {
    args: args ?? null,
  });
}

/** Probe direct child folders under sd_backup_folder. */
export async function probeClearLocalBackupFolders(
  args?: ClearLocalBackupFoldersArgs,
): Promise<LocalFolderClearProbe> {
  return invoke<LocalFolderClearProbe>("probe_clear_local_backup_folders", {
    args: args ?? null,
  });
}

/** Delete direct child backup folders; media-history hashes kept. */
export async function clearLocalBackupFolders(
  args?: ClearLocalBackupFoldersArgs,
): Promise<CacheCleanupResult> {
  return invoke<CacheCleanupResult>("clear_local_backup_folders", {
    args: args ?? null,
  });
}

/** Bring main window to foreground after an auto-update restart (no-op otherwise). */
export async function focusMainWindowAfterUpdate(): Promise<boolean> {
  return invoke<boolean>("focus_main_window_after_update");
}
