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
  "Drehen erfordert Neu-Kodierung…": "Drehen…",
  "Ersetze Original…": "Ersetze Datei…",
  "re-encode cut": "Schnitt (präzise)…",
  "stream-copy cut": "Schnitt…",
  "fast-concat": "Füge Clips zusammen (Fast Path)…",
  "Legacy-Zusammenfügen (MPEG-TS)…": "Legacy-Zusammenfügen…",
  "Fast Path fehlgeschlagen — warte auf Entscheidung…":
    "Fast Path fehlgeschlagen — bitte Entscheidung…",
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
  "Kodiere Intro+Video (kompatibel)…": "Kodiere Intro+Video…",
  "Kodiere Intro+Video (Audio-Copy)…": "Kodiere Intro+Video (Audio-Copy)…",
  "Audio anhängen (Copy)…": "Audio anhängen…",
  "Intro+Body durchgängig kodieren (kundenkompatibel)":
    "Kodiere Intro+Video (kompatibel)…",
  export: "Exportiere Video…",
  "export-done": "Export fertig",
  "preview-analyse": "Analysiere für Vorschau…",
  "preview-intro": "Vorschau-Intro…",
  "preview-reencode": "Kodiere Vorschau-Clips…",
  "preview-copy": "Kopiere Clips für Vorschau…",
  "preview-concat": "Füge Vorschau zusammen…",
  "Schreibe AMS-Manifest…": "Schreibe Übergabe…",
  "Nachreichung bereit für AMS": "Nachreichung bereit",
};

/** FFmpeg pipe status — keep previous human label instead of showing these. */
const TRANSIENT = new Set(["continue", "end"]);

/** Parent stage for nested create_video progress inside create_job. */
export const CREATE_VIDEO_STAGE = "Erstelle Video…";

/**
 * Stages where per-clip task bars are not meaningful — clear them on overall events.
 */
const CLEAR_TASK_BARS =
  /foto|wasserzeichen|upload|_fertig|vorgang fertig|erstelle intro|intro fertig|füge intro|zusammenfüg|analysiere intro|ohne intro|übernehme vorschau|exportiere video|kopiere fotos|generiere ausgabe|vorschau übernommen|video fertig|mpegts-concat|hevc-mkv-fallback|füge kodierte clips|füge clips zusammen…|kodiere intro\+video|schreibe ams-manifest|nachreichung bereit/i;

/**
 * create_job overall stages that must not be wrapped under „Erstelle Video…“.
 */
const CREATE_JOB_MAJOR_STAGE =
  /^(vorgang wird erstellt|generiere ausgabe|übernehme vorschau|vorschau übernommen|erstelle video|erstelle wasserzeichen-video|wasserzeichen-video:|kopiere fotos|kopiere foto \(|erstelle foto-wasserzeichen|foto-wasserzeichen|schreibe _fertig|überspringe _fertig|vorgang fertig|upload\b)/i;

/**
 * Nested processor / concat labels that belong under „Erstelle Video…“.
 * Only applied while the overall UI is already in that create_job stage
 * (so standalone cut/preview/create_video keep their own labels).
 */
const CREATE_VIDEO_DETAIL =
  /bereite videoclips|videoclips vorbereitet|füge .+clips|kodiere .+clips|clips parallel|erstelle intro|intro fertig|füge intro|zusammenfügen fertig|kodiere intro|analysiere intro|exportiere video|export fertig|video fertig|audio anhängen|ohne intro|kodiere neu|analysiere videos|analysiere intro\/video|füge clips|hevc|mpegts|clip-segment|stream-copy|fast-concat|fast path|legacy-zusammenfügen|probing|prepare/i;

const MAX_DETAIL_LEN = 42;

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

function isCreateJobMajorStage(label: string): boolean {
  return CREATE_JOB_MAJOR_STAGE.test(label.trim());
}

function isInCreateVideoStage(previous: string | undefined): boolean {
  const p = (previous ?? "").trim();
  return p === CREATE_VIDEO_STAGE || p.startsWith(`${CREATE_VIDEO_STAGE} (`);
}

function extractCreateVideoDetail(previous: string | undefined): string | null {
  const p = (previous ?? "").trim();
  const m = /^Erstelle Video…\s*\((.+)\)\s*$/.exec(p);
  return m?.[1]?.trim() || null;
}

function isCreateVideoDetail(label: string): boolean {
  const s = label.trim();
  if (!s || s === CREATE_VIDEO_STAGE) return false;
  if (isCreateJobMajorStage(s)) return false;
  if (s.startsWith(`${CREATE_VIDEO_STAGE} (`)) return false;
  return CREATE_VIDEO_DETAIL.test(s);
}

function shortenDetail(detail: string): string {
  let d = detail.trim();
  // Drop redundant trailing ellipsis inside parentheses; stage already has …
  if (d.endsWith("…")) d = d.slice(0, -1).trimEnd();
  if (d.length <= MAX_DETAIL_LEN) return d;
  return `${d.slice(0, MAX_DETAIL_LEN - 1).trimEnd()}…`;
}

/**
 * Overall progress label for create_job: keep „Erstelle Video…“ as parent and
 * show nested encode steps in parentheses, e.g.
 * `Erstelle Video… (Kodiere Intro+Video)`.
 *
 * Does not wrap standalone cut/preview/create_video flows (no prior stage).
 */
export function formatOverallProgressLabel(
  raw: string | undefined | null,
  previous?: string,
): string {
  const s = (raw ?? "").trim();
  if (!s || TRANSIENT.has(s)) {
    return previous?.trim() || "In Arbeit…";
  }

  const label = resolveProgressLabel(raw, previous);

  if (label === CREATE_VIDEO_STAGE || label.startsWith(`${CREATE_VIDEO_STAGE} (`)) {
    const detail = extractCreateVideoDetail(previous);
    if (detail && label === CREATE_VIDEO_STAGE) {
      return `${CREATE_VIDEO_STAGE} (${detail})`;
    }
    return label === CREATE_VIDEO_STAGE ? CREATE_VIDEO_STAGE : label;
  }

  if (isCreateVideoDetail(label) && isInCreateVideoStage(previous)) {
    return `${CREATE_VIDEO_STAGE} (${shortenDetail(label)})`;
  }

  return label;
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
