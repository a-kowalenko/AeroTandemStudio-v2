/** Map raw encode-progress `status` strings to German UI labels. */

const STATUS_LABELS: Record<string, string> = {
  starting: "Startet…",
  cancelled: "Abgebrochen",
  end: "Fertig",
  probing: "Analysiere Videos…",
  prepare: "Bereite Clip-Segment vor…",
  "prepare-done": "Clip-Segment bereit",
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
  "soft-splice: Intro+Übergang kodieren…": "Soft-Splice: Intro+Übergang…",
  "soft-splice: Rest anhängen…": "Soft-Splice: Rest anhängen…",
  "soft-splice: Ausgabe schreiben…": "Soft-Splice: Ausgabe schreiben…",
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
 * Stages where per-clip task bars are not meaningful — clear them on overall events.
 */
const CLEAR_TASK_BARS =
  /foto|wasserzeichen|upload|_fertig|vorgang fertig|erstelle intro|intro fertig|füge intro|zusammenfüg|analysiere intro|ohne intro|übernehme vorschau|exportiere video|kopiere fotos|generiere ausgabe|vorschau übernommen|video fertig|mpegts-concat|hevc-mkv-fallback|füge kodierte clips|füge clips zusammen…|soft-splice/i;

export function shouldClearTaskProgress(status: string | undefined | null): boolean {
  const s = (status ?? "").trim();
  if (!s) return false;
  return CLEAR_TASK_BARS.test(s);
}

/**
 * Keep overall percent from jittering backwards (FFmpeg out_time noise).
 * Allows reset to 0 and intentional large stage jumps forward only.
 */
export function applyMonotonicPercent(previous: number, next: number): number {
  const n = Math.max(0, Math.min(100, next));
  if (n <= 0) return 0;
  if (n + 0.05 >= previous) return n;
  // Ignore tiny backwards jitter (< 1.5 pp)
  if (previous - n < 1.5) return previous;
  return n;
}

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
    const mode =
      parallel[1] === "parallel" ? "Kodiere Clips parallel" : "Füge Clips parallel zusammen";
    return `${mode} (${parallel[3]} Clips, ${parallel[2]} Worker)…`;
  }

  return s;
}

export function taskProgressLabel(taskId: number, status?: string): string {
  const raw = (status ?? "").trim();
  if (!raw || TRANSIENT.has(raw)) {
    return `Clip ${taskId}: In Arbeit…`;
  }
  const resolved = resolveProgressLabel(raw, undefined);
  if (!resolved || resolved === "In Arbeit…") {
    return `Clip ${taskId}: In Arbeit…`;
  }
  // Backend already sent something like "Clip 2: name.mp4 — kodieren"
  if (/^clip\s*\d+/i.test(resolved) || resolved.includes(".mp4") || resolved.includes(".MP4")) {
    return resolved;
  }
  return `Clip ${taskId}: ${resolved}`;
}
