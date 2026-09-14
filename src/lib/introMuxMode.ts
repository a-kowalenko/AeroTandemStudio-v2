/** Canonical intro+body mux modes (mirror Rust `normalize_intro_mux_mode`). */

export type IntroMuxMode = "stream_copy" | "single_pass";

export function normalizeIntroMuxMode(raw: string | null | undefined): IntroMuxMode {
  const m = (raw ?? "").trim().toLowerCase();
  if (m === "single_pass" || m === "force_reencode" || m === "soft_splice") {
    return "single_pass";
  }
  return "stream_copy";
}

export function usesSinglePassIntroMux(raw: string | null | undefined): boolean {
  return normalizeIntroMuxMode(raw) === "single_pass";
}
