/** Canonical intro+body mux mode (mirror Rust `normalize_intro_mux_mode`). */

/** Sole product mode: CapCut-style universal H.264 export. */
export type IntroMuxMode = "capcut";

export function normalizeIntroMuxMode(
  _raw?: string | null | undefined,
): IntroMuxMode {
  return "capcut";
}

/** CapCut universal export uses one continuous intro+body encode. */
export function usesUnifiedIntroEncode(
  _raw?: string | null | undefined,
): boolean {
  return true;
}

/** @deprecated use usesUnifiedIntroEncode */
export function usesSinglePassIntroMux(raw?: string | null | undefined): boolean {
  return usesUnifiedIntroEncode(raw);
}
