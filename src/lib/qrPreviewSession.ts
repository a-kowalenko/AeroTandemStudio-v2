/** Best-effort cleanup for session QR hit-frame previews. */

import { discardQrPreview, type QrPreview } from "@/lib/tauri";

export function discardQrPreviewBestEffort(path: string | null | undefined) {
  const trimmed = path?.trim();
  if (!trimmed) return;
  void discardQrPreview(trimmed).catch(() => {
    /* ignore */
  });
}

/** Drop the previous preview file when replacing with a different path (or null). */
export function takeQrPreview(
  previous: QrPreview | null,
  next: QrPreview | null | undefined,
): QrPreview | null {
  const resolved = next ?? null;
  if (previous?.path && previous.path !== resolved?.path) {
    discardQrPreviewBestEffort(previous.path);
  }
  return resolved;
}
