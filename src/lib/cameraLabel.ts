/** Strip EXIF/FFmpeg quote padding junk (`"", "", ""`) to a real token or empty. */
function sanitizeCameraText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes('"') || trimmed.includes("'")) {
    for (const segment of trimmed.split(",")) {
      const seg = segment.trim().replace(/^["']+|["']+$/g, "").trim();
      if (seg) return seg;
    }
    return "";
  }
  return trimmed.replace(/^["']+|["']+$/g, "").trim();
}

/** Compact camera label for media list / tooltips. */
export function formatCameraLabel(
  make?: string | null,
  model?: string | null,
): string | null {
  const m = sanitizeCameraText(make ?? "");
  const mod = sanitizeCameraText(model ?? "");
  if (!m && !mod) return null;
  if (!m) return mod;
  if (!mod) return m;
  if (mod.toLowerCase().startsWith(m.toLowerCase())) return mod;
  return `${m} ${mod}`;
}
