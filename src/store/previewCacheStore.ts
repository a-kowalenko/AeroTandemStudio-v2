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
    introMuxMode.trim().toLowerCase() === "stream_copy" ||
    introMuxMode.trim().toLowerCase() === "stream-copy"
      ? "stream_copy"
      : "reencode";
  return `intro=${introEnabled ? 1 : 0}|dauer=${dauer}|mux=${mux}`;
}

export type PreviewReuseBlockReason =
  | "no_preview"
  | "clips_changed"
  | "form_changed"
  | "encoding_changed";

export type PreviewReusePlan =
  | { canReuse: true }
  | { canReuse: false; reason: PreviewReuseBlockReason };

function previewCacheMismatchReason(
  state: Pick<
    PreviewCacheState,
    "previewPath" | "fingerprint" | "videoSig" | "kundeSig" | "encodingSig"
  >,
  videos: VideoMetadata[],
  kunde: Kunde,
  encodingSig?: string | null,
): PreviewReuseBlockReason | null {
  if (
    !state.previewPath ||
    !state.fingerprint ||
    !state.videoSig ||
    !state.kundeSig
  ) {
    return "no_preview";
  }
  if (state.videoSig !== videoListSignature(videos)) {
    return "clips_changed";
  }
  if (state.kundeSig !== kundeSignature(kunde)) {
    return "form_changed";
  }
  if (encodingSig != null || state.encodingSig != null) {
    if ((encodingSig ?? null) !== (state.encodingSig ?? null)) {
      return "encoding_changed";
    }
  }
  return null;
}

/** Whether create can copy the cached preview instead of a full encode. */
export function getPreviewReusePlan(
  videos: VideoMetadata[],
  kunde: Kunde,
  encodingSig?: string | null,
): PreviewReusePlan {
  const reason = previewCacheMismatchReason(
    usePreviewCacheStore.getState(),
    videos,
    kunde,
    encodingSig,
  );
  return reason ? { canReuse: false, reason } : { canReuse: true };
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

  matches: (videos, kunde, encodingSig = null) =>
    previewCacheMismatchReason(get(), videos, kunde, encodingSig) === null,
}));
