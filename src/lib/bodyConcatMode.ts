import type { BodyConcatMode } from "./tauri";

/** Display-normalize aliases to the three Settings select values (parity with Rust). */
export function normalizeBodyConcatMode(mode: string | undefined | null): BodyConcatMode {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "legacy" || m === "mpegts" || m === "robust") return "legacy";
  if (m === "fast" || m === "fast_path" || m === "fast-path") return "fast";
  if (
    m === "compatible" ||
    m === "compat" ||
    m === "qt_safe" ||
    m === "prepared" ||
    m === "avidemux"
  ) {
    return "compatible";
  }
  return "compatible";
}

/** Full label for progress-panel badge. */
export function bodyConcatModeLabelKey(mode: BodyConcatMode): string {
  switch (mode) {
    case "compatible":
      return "workflow.bodyConcat.labelCompatible";
    case "legacy":
      return "workflow.bodyConcat.labelLegacy";
    default:
      return "workflow.bodyConcat.labelFast";
  }
}

/** Short label for collapsed progress chrome. */
export function bodyConcatModeShortLabelKey(mode: BodyConcatMode): string {
  switch (mode) {
    case "compatible":
      return "workflow.bodyConcat.shortCompatible";
    case "legacy":
      return "workflow.bodyConcat.shortLegacy";
    default:
      return "workflow.bodyConcat.shortFast";
  }
}

/** Chip tone for progress-panel badge. */
export function bodyConcatModeToneClass(mode: BodyConcatMode): string {
  switch (mode) {
    case "compatible":
      return "border-border/60 bg-muted/40 text-foreground/80";
    case "legacy":
      return "border-border/50 bg-transparent text-muted-foreground";
    default:
      // Fast path — slightly more visible (player risk).
      return "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100";
  }
}
