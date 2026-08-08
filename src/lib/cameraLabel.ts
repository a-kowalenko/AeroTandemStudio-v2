/** Compact camera label for media list / tooltips. */
export function formatCameraLabel(
  make?: string | null,
  model?: string | null,
): string | null {
  const m = (make ?? "").trim();
  const mod = (model ?? "").trim();
  if (!m && !mod) return null;
  if (!m) return mod;
  if (!mod) return m;
  if (mod.toLowerCase().startsWith(m.toLowerCase())) return mod;
  return `${m} ${mod}`;
}
