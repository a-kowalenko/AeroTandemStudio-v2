/** Soft confirm when upload is on but the server is offline (Phase 31.1). */

export type OfflineCreateConfirmState = {
  /** Sentinel so the dialog can open with a non-null state object. */
  open: true;
};
