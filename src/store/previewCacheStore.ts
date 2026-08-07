import { create } from "zustand";
import type { Kunde, PreviewResult, VideoMetadata } from "../lib/tauri";

/** Soft signature for UI invalidation (paths + size + duration + form). */
export function videoListSignature(videos: VideoMetadata[]): string {
  return videos
    .map((v) => `${v.path}|${v.size_bytes}|${v.duration_secs}`)
    .join("\n");
}

export function kundeSignature(kunde: Kunde): string {
  return JSON.stringify(kunde);
}

/** Encoding options that change the preview bitstream. */
export function previewEncodingSignature(
  introEnabled: boolean,
  dauer: number,
  introMuxMode: string,
): string {
  const mux =
    introMuxMode.trim().toLowerCase() === "soft_splice" ||
    introMuxMode.trim().toLowerCase() === "soft-splice"
      ? "soft_splice"
      : "stream_copy";
  return `intro=${introEnabled ? 1 : 0}|dauer=${dauer}|mux=${mux}`;
}

type PreviewCacheState = {
  previewPath: string | null;
  fingerprint: string | null;
  videoSig: string | null;
  kundeSig: string | null;
  encodingSig: string | null;
  setFromPreview: (
    result: PreviewResult,
    videos: VideoMetadata[],
    kunde: Kunde,
    encodingSig?: string | null,
  ) => void;
  clear: () => void;
  /**
   * True when the cached preview still matches current form + clips (+ encoding).
   * False (stale) → UI keeps showing the old preview, but create must re-encode.
   */
  matches: (
    videos: VideoMetadata[],
    kunde: Kunde,
    encodingSig?: string | null,
  ) => boolean;
};

export const usePreviewCacheStore = create<PreviewCacheState>((set, get) => ({
  previewPath: null,
  fingerprint: null,
  videoSig: null,
  kundeSig: null,
  encodingSig: null,

  setFromPreview: (result, videos, kunde, encodingSig = null) => {
    if (!result.preview_path || !result.fingerprint) {
      set({
        previewPath: null,
        fingerprint: null,
        videoSig: null,
        kundeSig: null,
        encodingSig: null,
      });
      return;
    }
    set({
      previewPath: result.preview_path,
      fingerprint: result.fingerprint,
      videoSig: videoListSignature(videos),
      kundeSig: kundeSignature(kunde),
      encodingSig: encodingSig ?? null,
    });
  },

  clear: () =>
    set({
      previewPath: null,
      fingerprint: null,
      videoSig: null,
      kundeSig: null,
      encodingSig: null,
    }),

  matches: (videos, kunde, encodingSig = null) => {
    const state = get();
    if (
      !state.previewPath ||
      !state.fingerprint ||
      !state.videoSig ||
      !state.kundeSig
    ) {
      return false;
    }
    if (
      state.videoSig !== videoListSignature(videos) ||
      state.kundeSig !== kundeSignature(kunde)
    ) {
      return false;
    }
    if (encodingSig != null || state.encodingSig != null) {
      return (encodingSig ?? null) === (state.encodingSig ?? null);
    }
    return true;
  },
}));
