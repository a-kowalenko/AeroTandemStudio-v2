/** Soft-confirm when SMB reconnects and uploads are pending (Phase 31.9 / 31.10). */

import type { VorgangEntry } from "./vorgangHistory";

/** Wait after SMB false→true before offering (flap guard). */
export const RECONNECT_UPLOAD_OFFER_STABLE_MS = 2500;

/**
 * Delay after gates clear before mounting the dialog — avoids Radix stacking
 * with Settings / success dialogs that would immediately dismiss the offer.
 */
export const RECONNECT_UPLOAD_OFFER_OPEN_DELAY_MS = 350;

/**
 * Ignore Dialog `onOpenChange(false)` for this long after open so focus/stack
 * teardown does not count as „Später“.
 */
export const RECONNECT_UPLOAD_OFFER_DISMISS_GRACE_MS = 400;

export type ReconnectUploadOfferState = {
  open: true;
  /** Outstanding upload candidates at offer time (oldest first). */
  entries: VorgangEntry[];
};

/** i18n keys under `form.media.*` for active products. */
export type PendingUploadMediaKey =
  | "handcamVideo"
  | "handcamPhoto"
  | "outsideVideo"
  | "outsidePhoto";

export type PendingUploadPreviewLine = {
  vorgangId: number;
  guest: string;
  mediaKeys: PendingUploadMediaKey[];
  tandemmaster: string | null;
  videospringer: string | null;
};

/** Guest label for compact reconnect / bulk lists. */
export function pendingUploadGuestLabel(entry: VorgangEntry): string {
  const gast = entry.gast?.trim();
  if (gast) return gast;
  const base = entry.base_filename?.trim();
  if (base) return base;
  return `#${entry.id}`;
}

/** Active media products for a Vorgang (order: HV, HF, OV, OF). */
export function pendingUploadMediaKeys(
  entry: VorgangEntry,
): PendingUploadMediaKey[] {
  const keys: PendingUploadMediaKey[] = [];
  if (entry.handcam_video) keys.push("handcamVideo");
  if (entry.handcam_foto) keys.push("handcamPhoto");
  if (entry.outside_video) keys.push("outsideVideo");
  if (entry.outside_foto) keys.push("outsidePhoto");
  return keys;
}

export function pendingUploadPreviewLine(
  entry: VorgangEntry,
): PendingUploadPreviewLine {
  return {
    vorgangId: entry.id,
    guest: pendingUploadGuestLabel(entry),
    mediaKeys: pendingUploadMediaKeys(entry),
    tandemmaster: entry.tandemmaster?.trim() || null,
    videospringer: entry.videospringer?.trim() || null,
  };
}

/** Split offer entries into upload vs ignore sets (Phase 31.10). */
export function partitionReconnectUploadSelection(
  entries: VorgangEntry[],
  selectedIds: number[],
): { toUpload: VorgangEntry[]; toIgnore: VorgangEntry[] } {
  const selected = new Set(selectedIds);
  const toUpload: VorgangEntry[] = [];
  const toIgnore: VorgangEntry[] = [];
  for (const entry of entries) {
    if (selected.has(entry.id)) toUpload.push(entry);
    else toIgnore.push(entry);
  }
  return { toUpload, toIgnore };
}
