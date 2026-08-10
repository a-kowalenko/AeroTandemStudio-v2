import { invoke } from "@tauri-apps/api/core";

/**
 * URL for local video playback via the loopback HTTP media server.
 *
 * WebKitGTK cannot reliably play custom schemes (`asset://` / `media://`);
 * Range-capable `http://127.0.0.1` works for preview and multi‑GB clips.
 *
 * `cacheBust` must change when the file is overwritten in place (trim), otherwise
 * the browser keeps serving the previous body for the same URL.
 */
export async function videoFileSrc(
  path: string,
  cacheBust?: string | number | null,
): Promise<string> {
  const url = await invoke<string>("media_file_url", { path });
  if (cacheBust == null || cacheBust === "") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(String(cacheBust))}`;
}
