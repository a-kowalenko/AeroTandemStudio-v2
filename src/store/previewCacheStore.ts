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

type PreviewCacheState = {
  previewPath: string | null;
  fingerprint: string | null;
  videoSig: string | null;
  kundeSig: string | null;
  setFromPreview: (
    result: PreviewResult,
    videos: VideoMetadata[],
    kunde: Kunde,
  ) => void;
  clear: () => void;
  /**
   * True when the cached preview still matches current form + clips.
   * False (stale) → UI keeps showing the old preview, but create must re-encode.
   */
  matches: (videos: VideoMetadata[], kunde: Kunde) => boolean;
};

export const usePreviewCacheStore = create<PreviewCacheState>((set, get) => ({
  previewPath: null,
  fingerprint: null,
  videoSig: null,
  kundeSig: null,

  setFromPreview: (result, videos, kunde) => {
    if (!result.preview_path || !result.fingerprint) {
      set({
        previewPath: null,
        fingerprint: null,
        videoSig: null,
        kundeSig: null,
      });
      return;
    }
    set({
      previewPath: result.preview_path,
      fingerprint: result.fingerprint,
      videoSig: videoListSignature(videos),
      kundeSig: kundeSignature(kunde),
    });
  },

  clear: () =>
    set({
      previewPath: null,
      fingerprint: null,
      videoSig: null,
      kundeSig: null,
    }),

  matches: (videos, kunde) => {
    const { previewPath, fingerprint, videoSig, kundeSig } = get();
    if (!previewPath || !fingerprint || !videoSig || !kundeSig) return false;
    return (
      videoSig === videoListSignature(videos) &&
      kundeSig === kundeSignature(kunde)
    );
  },
}));
