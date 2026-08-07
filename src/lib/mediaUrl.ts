import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * URL for local video playback via the custom `media` URI scheme.
 *
 * Prefer this over bare `convertFileSrc` (asset protocol): on Linux, WebKitGTK
 * often requests the whole file without Range, and asset:// would read multi‑GB
 * clips into memory and freeze the UI.
 */
export function videoFileSrc(path: string): string {
  return convertFileSrc(path, "media");
}
