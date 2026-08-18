/** Kunden-ID focus after QR miss / import without QR (not on empty-form start). */

import { useKundeStore } from "@/store/kundeStore";

/** Queue focus; CustomerForm runs it when ID-mode is idle and dialogs are closed. */
export function requestKundenIdFocus(): void {
  const s = useKundeStore.getState();
  if (s.kunde.form_mode === "kunde") return;
  if (s.amsLookupLocked) return;
  if ((s.kunde.kunden_id ?? "").trim()) return;
  s.requestKundenIdFocus();
}

/**
 * After media landed: focus IDs when QR was off, or ran and missed.
 * Skip QR hit, cancel, and “not attempted” (already a QR session).
 */
export function requestKundenIdFocusAfterImport(opts: {
  scanned: boolean;
  attempted?: boolean;
  found?: boolean;
  cancelled?: boolean;
}): void {
  if (opts.scanned) {
    if (!opts.attempted || opts.found || opts.cancelled) return;
  }
  requestKundenIdFocus();
}
