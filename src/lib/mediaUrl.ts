import { invoke } from "@tauri-apps/api/core";

/**
 * URL for local video playback via the loopback HTTP media server.
 *
 * WebKitGTK cannot reliably play custom schemes (`asset://` / `media://`);
 * Range-capable `http://127.0.0.1` works for preview and multi‑GB clips.
 */
export async function videoFileSrc(path: string): Promise<string> {
  return invoke<string>("media_file_url", { path });
}
