import { invoke } from "@tauri-apps/api/core";
import type { QrPreview } from "./tauri";

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
};

export type VorgangFileEntry = {
  id: number;
  vorgang_id: number;
  filename: string;
  media_type: string;
  role: string;
  size_bytes: number | null;
  path: string | null;
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
