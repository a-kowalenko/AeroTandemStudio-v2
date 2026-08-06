/** Map raw encode-progress `status` strings to German UI labels. */

const STATUS_LABELS: Record<string, string> = {
  starting: "Startet…",
  cancelled: "Abgebrochen",
  end: "Fertig",
  probing: "Analysiere Videos…",
  prepare: "Bereite Clip vor…",
  "prepare-done": "Clip vorbereitet",
  "mpegts-concat": "Füge Clips zusammen…",
  "hevc-mkv-fallback": "HEVC-Fallback…",
  "re-encode": "Kodiere neu…",
  "re-encode trim": "Zuschneiden (präzise)…",
  "stream-copy trim": "Zuschneiden…",
  "re-encode cut": "Schnitt (präzise)…",
  "stream-copy cut": "Schnitt…",
  "replacing original": "Ersetze Original…",
  "split part 1": "Teile Clip (Teil 1)…",
  "split part 2": "Teile Clip (Teil 2)…",
  "renaming split outputs": "Benenne geteilte Clips…",
  body: "Bereite Videoclips vor…",
  "body-done": "Videoclips vorbereitet",
  intro: "Erstelle Intro…",
  "intro-done": "Intro fertig",
  mux: "Füge Intro und Video zusammen…",
  "mux-done": "Zusammenfügen fertig",
  export: "Exportiere Video…",
  "export-done": "Export fertig",
  "preview-analyse": "Analysiere für Vorschau…",
  "preview-intro": "Vorschau-Intro…",
  "preview-reencode": "Kodiere Vorschau-Clips…",
  "preview-copy": "Kopiere Clips für Vorschau…",
  "preview-concat": "Füge Vorschau zusammen…",
};

/** FFmpeg pipe status — keep previous human label instead of showing these. */
const TRANSIENT = new Set(["continue", "end"]);

/**
 * Returns a display label for a progress status, or `null` if the previous
 * label should be kept (e.g. ffmpeg `continue`).
 */
export function resolveProgressLabel(
  raw: string | undefined | null,
  previous?: string,
): string {
  const s = (raw ?? "").trim();
  if (!s || TRANSIENT.has(s)) {
    return previous?.trim() || "In Arbeit…";
  }
  if (STATUS_LABELS[s]) return STATUS_LABELS[s];

  // Already localized stage strings from the backend (contain spaces / umlauts)
  if (/[äöüÄÖÜß ]/.test(s) || s.includes("…") || s.includes(":")) {
    return s;
  }

  // body-parallel workers=2 clips=3 → readable
  const parallel = /^body-(parallel|concat-parallel)\s+workers=(\d+)\s+clips=(\d+)/i.exec(s);
  if (parallel) {
    const mode = parallel[1] === "parallel" ? "Kodiere Clips parallel" : "Füge Clips parallel zusammen";
    return `${mode} (${parallel[3]} Clips, ${parallel[2]} Worker)…`;
  }

  return s;
}

export function taskProgressLabel(taskId: number, status?: string): string {
  const resolved = resolveProgressLabel(status, undefined);
  if (resolved && resolved !== "In Arbeit…" && !TRANSIENT.has(status ?? "")) {
    // Backend already sent something like "Clip 2: name.mp4 — kodieren"
    if (/clip/i.test(resolved) || resolved.includes(".mp4") || resolved.includes(".MP4")) {
      return resolved;
    }
    return `Clip ${taskId}: ${resolved}`;
  }
  return `Clip ${taskId}`;
}
