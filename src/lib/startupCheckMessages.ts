import { tr } from "@/i18n";

const FFMPEG_BINARY_NOT_FOUND =
  "FFmpeg binary not found (expected under resources/ffmpeg/)";

const FFMPEG_MISSING_MESSAGE =
  "FFmpeg nicht gefunden — Encoding nicht möglich.";

const GST_WARNING_PREFIXES: Record<string, string> = {
  "GStreamer-Basisplugins fehlen — Video-Wiedergabe nicht möglich. Installieren: ":
    "app.splash.gstBasePluginsMissing",
  "Kein H.264-Decoder in GStreamer gefunden — MP4-Vorschau bleibt schwarz. Installieren: ":
    "app.splash.gstH264DecoderMissing",
  "GStreamer-Codecs nicht gefunden — Video-Wiedergabe kann fehlschlagen. Installieren: ":
    "app.splash.gstCodecsMissing",
};

/** Translate Rust `run_startup_checks` summary for splash status. */
export function presentStartupCheckMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed === FFMPEG_MISSING_MESSAGE) {
    return tr("app.splash.ffmpegMissing");
  }

  const readyMatch = /^Bereit — FFmpeg OK, Encoder (.+)$/.exec(trimmed);
  if (readyMatch) {
    return tr("app.splash.checksOk", { encoder: readyMatch[1] });
  }

  return message;
}

/** Translate Rust FFmpeg lookup error for splash / toast. */
export function presentStartupFfmpegError(error: string | null): string | null {
  if (!error?.trim()) return null;
  if (error.trim() === FFMPEG_BINARY_NOT_FOUND) {
    return tr("app.splash.ffmpegBinaryNotFound");
  }
  return error;
}

/** Translate Rust Linux GStreamer warning for splash / toast. */
export function presentLinuxMediaWarning(
  warning: string | null,
): string | null {
  if (!warning?.trim()) return null;
  for (const [prefix, key] of Object.entries(GST_WARNING_PREFIXES)) {
    if (warning.startsWith(prefix)) {
      return tr(key, { installHint: warning.slice(prefix.length) });
    }
  }
  return warning;
}
