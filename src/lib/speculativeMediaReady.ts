import type { Kunde } from "./tauri";

/** Inputs for speculative media/product gate (Phase 46 variant 2). */
export type SpeculativeMediaReadyInput = {
  handcam_video: boolean;
  outside_video: boolean;
  handcam_foto: boolean;
  outside_foto: boolean;
  /** Kept for API stability; WM selection is not required to start staging. */
  ist_bezahlt_handcam_foto?: boolean;
  ist_bezahlt_outside_foto?: boolean;
  videoCount: number;
  photoCount: number;
  /** Kept for API stability; unpaid WM gate applies to Erstellen, not staging start. */
  watermarkPhotoCount?: number;
};

/**
 * True when products + media are enough to stage body/photos.
 * Does **not** require form completeness (`createReady`) or WM selection.
 * Unpaid-foto WM remains a hard gate on Erstellen / `validate_create_job`.
 */
export function isSpeculativeMediaReady(
  input: SpeculativeMediaReadyInput,
): boolean {
  const videoProd = input.handcam_video || input.outside_video;
  const fotoProd = input.handcam_foto || input.outside_foto;
  if (!videoProd && !fotoProd) return false;
  if (videoProd && input.videoCount <= 0) return false;
  if (fotoProd && input.photoCount <= 0) return false;
  return true;
}

export function speculativeMediaReadyFromKunde(
  kunde: Pick<
    Kunde,
    | "handcam_video"
    | "outside_video"
    | "handcam_foto"
    | "outside_foto"
  >,
  videoCount: number,
  photoCount: number,
  _watermarkPhotoCount = 0,
): boolean {
  return isSpeculativeMediaReady({
    handcam_video: kunde.handcam_video,
    outside_video: kunde.outside_video,
    handcam_foto: kunde.handcam_foto,
    outside_foto: kunde.outside_foto,
    videoCount,
    photoCount,
  });
}
