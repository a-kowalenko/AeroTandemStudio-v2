import type { BodyConcatMode } from "./tauri";

/** Settings select values (Fast/Legacy removed from UI; still valid at runtime). */
export type SettingsBodyConcatMode = "auto" | "compatible" | "apple";

/** Display-normalize aliases to canonical mode values (parity with Rust). */
export function normalizeBodyConcatMode(mode: string | undefined | null): BodyConcatMode {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "legacy" || m === "mpegts" || m === "robust") return "legacy";
  if (m === "fast" || m === "fast_path" || m === "fast-path") return "fast";
  if (m === "apple" || m === "hvc1" || m === "iphone") return "apple";
  if (m === "auto" || m === "preserve" || m === "source_tag") return "auto";
  if (
    m === "compatible" ||
    m === "compat" ||
    m === "qt_safe" ||
    m === "prepared" ||
    m === "avidemux"
  ) {
    return "compatible";
  }
  return "auto";
}

/**
 * Mode for Settings select: Auto / Compatible-family overrides.
 * Fast/Legacy configs map to `auto`.
 */
export function settingsBodyConcatMode(
  mode: string | undefined | null,
): SettingsBodyConcatMode {
  const n = normalizeBodyConcatMode(mode);
  if (n === "apple") return "apple";
  if (n === "compatible") return "compatible";
  return "auto";
}

/** Compatible-family modes that allow speculative Create staging. */
export function isSpeculativeBodyConcatMode(mode: BodyConcatMode): boolean {
  return mode === "compatible" || mode === "apple" || mode === "auto";
}

/** Full label for progress-panel badge. */
export function bodyConcatModeLabelKey(mode: BodyConcatMode): string {
  switch (mode) {
    case "auto":
      return "workflow.bodyConcat.labelAuto";
    case "compatible":
      return "workflow.bodyConcat.labelCompatible";
    case "apple":
      return "workflow.bodyConcat.labelApple";
    case "legacy":
      return "workflow.bodyConcat.labelLegacy";
    default:
      return "workflow.bodyConcat.labelFast";
  }
}

/** Short label for collapsed progress chrome. */
export function bodyConcatModeShortLabelKey(mode: BodyConcatMode): string {
  switch (mode) {
    case "auto":
      return "workflow.bodyConcat.shortAuto";
    case "compatible":
      return "workflow.bodyConcat.shortCompatible";
    case "apple":
      return "workflow.bodyConcat.shortApple";
    case "legacy":
      return "workflow.bodyConcat.shortLegacy";
    default:
      return "workflow.bodyConcat.shortFast";
  }
}

/** Chip tone for progress-panel badge. */
export function bodyConcatModeToneClass(mode: BodyConcatMode): string {
  switch (mode) {
    case "auto":
      return "border-border/60 bg-muted/30 text-foreground/80";
    case "compatible":
      return "border-border/60 bg-muted/40 text-foreground/80";
    case "apple":
      return "border-sky-500/40 bg-sky-500/10 text-sky-950 dark:text-sky-100";
    case "legacy":
      return "border-border/50 bg-transparent text-muted-foreground";
    default:
      // Fast path — slightly more visible (player risk).
      return "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100";
  }
}
