/** Map raw encode-progress `status` strings to localized UI labels. */

import { tr } from "@/i18n";

const TRANSIENT = new Set(["continue", "end"]);

/** Machine keys and German backend strings → i18n keys. */
const RAW_TO_I18N: Record<string, string> = {
  starting: "progress.default.starting",
  cancelled: "progress.default.cancelled",
  end: "progress.default.done",
  probing: "progress.status.probing",
  prepare: "progress.status.prepare",
  "prepare-done": "progress.status.prepareDone",
  "mpegts-concat": "progress.status.mpegtsConcat",
  "hevc-mkv-fallback": "progress.status.hevcFallback",
  "re-encode": "progress.status.reencode",
  "re-encode trim": "progress.status.reencodeTrim",
  "stream-copy trim": "progress.status.streamCopyTrim",
  "Drehen erfordert Neu-Kodierung…": "progress.status.rotateReencode",
  "Ersetze Original…": "progress.status.replaceFile",
  "re-encode cut": "progress.status.reencodeCut",
  "stream-copy cut": "progress.status.streamCopyCut",
  "fast-concat": "progress.status.fastConcat",
  "Legacy-Zusammenfügen (MPEG-TS)…": "progress.rust.legacyMpegTs",
  "Fast Path fehlgeschlagen — warte auf Entscheidung…":
    "progress.status.fastPathWaiting",
  "replacing original": "progress.status.replaceOriginal",
  "split part 1": "progress.status.splitPart1",
  "split part 2": "progress.status.splitPart2",
  "renaming split outputs": "progress.status.renameSplit",
  body: "progress.status.bodyPrepare",
  "body-done": "progress.status.bodyDone",
  intro: "progress.status.intro",
  "intro-done": "progress.status.introDone",
  mux: "progress.status.mux",
  "mux-done": "progress.status.muxDone",
  "Kodiere Intro+Video (kompatibel)…": "progress.status.introVideoCompatible",
  "Kodiere Intro+Video (Audio-Copy)…": "progress.status.introVideoAudioCopy",
  "Audio anhängen (Copy)…": "progress.status.attachAudio",
  "Intro+Body durchgängig kodieren (kundenkompatibel)":
    "progress.status.introVideoCompatible",
  export: "progress.status.export",
  "export-done": "progress.status.exportDone",
  "preview-analyse": "progress.status.previewAnalyse",
  "preview-intro": "progress.status.previewIntro",
  "preview-reencode": "progress.status.previewReencode",
  "preview-copy": "progress.status.previewCopy",
  "preview-concat": "progress.status.previewConcat",
  "Schreibe AMS-Manifest…": "progress.rust.writeAmsManifest",
  "Nachreichung bereit für AMS": "progress.rust.appendReadyForAms",
  "Generiere Ausgabe-Verzeichnis…": "progress.rust.generateOutputDir",
  "Übernehme Vorschau als Finalvideo…": "progress.rust.reusePreview",
  "Vorschau übernommen": "progress.rust.previewReused",
  "Neu-Kodierung — warte auf Bestätigung…": "progress.rust.reencodeWaiting",
  "Erstelle Video…": "progress.createVideoStage",
  "Erstelle Wasserzeichen-Video…": "progress.rust.createWatermarkVideo",
  "Kopiere Fotos…": "progress.rust.copyPhotos",
  "Sortiere Fotos…": "progress.rust.sortPhotos",
  "Lese Foto-Metadaten…": "progress.rust.readPhotoMeta",
  "Erstelle Foto-Wasserzeichen…": "progress.rust.createPhotoWatermark",
  "Überspringe _fertig.txt (Lokal)…": "progress.rust.skipDoneTxtLocal",
  "Schreibe _fertig.txt…": "progress.rust.writeDoneTxt",
  "Vorgang fertig": "create.job.done",
  "Vorgang wird erstellt…": "create.job.creating",
  "Füge kodierte Clips zusammen…": "progress.rust.joinEncodedClips",
  "Analysiere Intro/Video…": "progress.rust.analyseIntroVideo",
  "Stream-Copy fehlgeschlagen — bitte Entscheidung…":
    "progress.rust.streamCopyFailedWaiting",
  "Exportiere Video ohne Intro…": "progress.rust.exportWithoutIntro",
  "SD wird bereinigt…": "progress.rust.sdClearing",
  "Backup wird abgeschlossen…": "progress.rust.backupFinishing",
};

export function createVideoStageLabel(): string {
  return tr("progress.createVideoStage");
}

/** Parent stage for nested create_video progress inside create_job. */
export const CREATE_VIDEO_STAGE = "Erstelle Video…";

const CLEAR_TASK_BARS =
  /foto|wasserzeichen|upload|_fertig|vorgang fertig|erstelle intro|intro fertig|füge intro|zusammenfüg|analysiere intro|ohne intro|übernehme vorschau|exportiere video|kopiere fotos|generiere ausgabe|vorschau übernommen|video fertig|mpegts-concat|hevc-mkv-fallback|füge kodierte clips|füge clips zusammen…|kodiere intro\+video|schreibe ams-manifest|nachreichung bereit/i;

const CREATE_JOB_MAJOR_STAGE =
  /^(vorgang wird erstellt|generiere ausgabe|übernehme vorschau|vorschau übernommen|erstelle video|erstelle wasserzeichen-video|wasserzeichen-video:|kopiere fotos|kopiere foto \(|erstelle foto-wasserzeichen|foto-wasserzeichen|schreibe _fertig|überspringe _fertig|vorgang fertig|upload\b)/i;

const CREATE_VIDEO_DETAIL =
  /bereite videoclips|videoclips vorbereitet|füge .+clips|kodiere .+clips|clips parallel|erstelle intro|intro fertig|füge intro|zusammenfügen fertig|kodiere intro|analysiere intro|exportiere video|export fertig|video fertig|audio anhängen|ohne intro|kodiere neu|analysiere videos|analysiere intro\/video|füge clips|hevc|mpegts|clip-segment|stream-copy|fast-concat|fast path|legacy-zusammenfügen|probing|prepare/i;

const MAX_DETAIL_LEN = 42;

function inProgressLabel(): string {
  return tr("progress.default.inProgress");
}

function translateRaw(raw: string): string | null {
  const key = RAW_TO_I18N[raw];
  if (key) return tr(key);
  return null;
}

export function shouldClearTaskProgress(status: string | undefined | null): boolean {
  const s = (status ?? "").trim();
  if (!s) return false;
  return CLEAR_TASK_BARS.test(s);
}

export function applyMonotonicPercent(previous: number, next: number): number {
  const n = Math.max(0, Math.min(100, next));
  if (n <= 0) return 0;
  if (n + 0.05 >= previous) return n;
  if (previous - n < 1.5) return previous;
  return n;
}

export function resolveProgressLabel(
  raw: string | undefined | null,
  previous?: string,
): string {
  const s = (raw ?? "").trim();
  if (!s || TRANSIENT.has(s)) {
    return previous?.trim() || inProgressLabel();
  }

  const mapped = translateRaw(s);
  if (mapped) return mapped;

  const parallel = /^body-(parallel|concat-parallel)\s+workers=(\d+)\s+clips=(\d+)/i.exec(s);
  if (parallel) {
    const key =
      parallel[1] === "parallel"
        ? "progress.status.parallelEncode"
        : "progress.status.parallelConcat";
    return tr(key, { workers: parallel[2], clips: parallel[3] });
  }

  if (/[äöüÄÖÜß ]/.test(s) || s.includes("…") || s.includes(":")) {
    return s;
  }

  return s;
}

function isCreateJobMajorStage(label: string): boolean {
  return CREATE_JOB_MAJOR_STAGE.test(label.trim());
}

function isInCreateVideoStage(previous: string | undefined): boolean {
  const p = (previous ?? "").trim();
  const stage = createVideoStageLabel();
  return p === stage || p.startsWith(`${stage} (`);
}

function extractCreateVideoDetail(previous: string | undefined): string | null {
  const p = (previous ?? "").trim();
  const stage = createVideoStageLabel();
  const m = new RegExp(`^${escapeRegExp(stage)}\\s*\\((.+)\\)\\s*$`).exec(p);
  return m?.[1]?.trim() || null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCreateVideoDetail(label: string): boolean {
  const s = label.trim();
  const stage = createVideoStageLabel();
  if (!s || s === stage) return false;
  if (isCreateJobMajorStage(s)) return false;
  if (s.startsWith(`${stage} (`)) return false;
  return CREATE_VIDEO_DETAIL.test(s);
}

function shortenDetail(detail: string): string {
  let d = detail.trim();
  if (d.endsWith("…")) d = d.slice(0, -1).trimEnd();
  if (d.length <= MAX_DETAIL_LEN) return d;
  return `${d.slice(0, MAX_DETAIL_LEN - 1).trimEnd()}…`;
}

export function formatOverallProgressLabel(
  raw: string | undefined | null,
  previous?: string,
): string {
  const s = (raw ?? "").trim();
  if (!s || TRANSIENT.has(s)) {
    return previous?.trim() || inProgressLabel();
  }

  const label = resolveProgressLabel(raw, previous);
  const stage = createVideoStageLabel();

  if (label === stage || label.startsWith(`${stage} (`)) {
    const detail = extractCreateVideoDetail(previous);
    if (detail && label === stage) {
      return `${stage} (${detail})`;
    }
    return label === stage ? stage : label;
  }

  if (isCreateVideoDetail(label) && isInCreateVideoStage(previous)) {
    return `${stage} (${shortenDetail(label)})`;
  }

  return label;
}

export function taskProgressLabel(taskId: number, status?: string): string {
  const raw = (status ?? "").trim();
  if (!raw || TRANSIENT.has(raw)) {
    return tr("progress.clip.inProgress", { id: taskId });
  }
  const resolved = resolveProgressLabel(raw, undefined);
  if (!resolved || resolved === inProgressLabel()) {
    return tr("progress.clip.inProgress", { id: taskId });
  }
  if (/^clip\s*\d+/i.test(resolved) || resolved.includes(".mp4") || resolved.includes(".MP4")) {
    return resolved;
  }
  return tr("progress.clip.withStatus", { id: taskId, status: resolved });
}
