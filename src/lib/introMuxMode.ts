/** Canonical intro+body mux modes (mirror Rust `normalize_intro_mux_mode`). */

export type IntroMuxMode = "stream_copy" | "capcut" | "single_pass";

export function normalizeIntroMuxMode(
  raw: string | null | undefined,
): IntroMuxMode {
  const m = (raw ?? "").trim().toLowerCase();
  if (m === "capcut" || m === "universal" || m === "export") {
    return "capcut";
  }
  if (m === "single_pass" || m === "force_reencode" || m === "soft_splice") {
    return "single_pass";
  }
  return "stream_copy";
}

/** One continuous intro+body encode (CapCut universal export or max-safety single-pass). */
export function usesUnifiedIntroEncode(
  raw: string | null | undefined,
): boolean {
  const mode = normalizeIntroMuxMode(raw);
  return mode === "capcut" || mode === "single_pass";
}

/** @deprecated use usesUnifiedIntroEncode */
export function usesSinglePassIntroMux(raw: string | null | undefined): boolean {
  return usesUnifiedIntroEncode(raw);
}
