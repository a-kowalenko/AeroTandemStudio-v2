/** Frontend bindings for the optional mpv Cutter/clip backend (OPT-13). */

import { invoke } from "@tauri-apps/api/core";

export type MpvAvailability = {
  available: boolean;
  backend: string;
  mpv_path: string | null;
  libmpv_path: string | null;
  detail: string;
};

export type MpvSessionInfo = {
  session_id: number;
  frame_path: string;
  duration_ms: number;
};

export type MpvSessionSnapshot = {
  session_id: number;
  current_ms: number;
  duration_ms: number;
  paused: boolean;
  eof_reached: boolean;
  frame_rev: number;
};

export async function mpvPlayerStatus(): Promise<MpvAvailability> {
  return invoke<MpvAvailability>("mpv_player_status");
}

export async function mpvPlayerOpen(path: string): Promise<MpvSessionInfo> {
  return invoke<MpvSessionInfo>("mpv_player_open", { path });
}

export async function mpvPlayerClose(sessionId: number): Promise<void> {
  await invoke("mpv_player_close", { sessionId });
}

export async function mpvPlayerSeek(
  sessionId: number,
  ms: number,
): Promise<MpvSessionSnapshot> {
  return invoke<MpvSessionSnapshot>("mpv_player_seek", { sessionId, ms });
}

export async function mpvPlayerPlay(
  sessionId: number,
): Promise<MpvSessionSnapshot> {
  return invoke<MpvSessionSnapshot>("mpv_player_play", { sessionId });
}

export async function mpvPlayerPause(
  sessionId: number,
): Promise<MpvSessionSnapshot> {
  return invoke<MpvSessionSnapshot>("mpv_player_pause", { sessionId });
}

export async function mpvPlayerSetVolume(
  sessionId: number,
  volume: number,
  muted: boolean,
): Promise<void> {
  await invoke("mpv_player_set_volume", { sessionId, volume, muted });
}

export async function mpvPlayerTick(
  sessionId: number,
): Promise<MpvSessionSnapshot> {
  return invoke<MpvSessionSnapshot>("mpv_player_tick", { sessionId });
}

export async function mpvPlayerFrameUrl(
  sessionId: number,
  frameRev: number,
): Promise<string> {
  return invoke<string>("mpv_player_frame_url", { sessionId, frameRev });
}
