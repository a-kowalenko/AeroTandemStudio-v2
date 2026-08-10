/** Shared copy + dialog options for successful QR customer recognition. */

import type { Kunde } from "@/lib/tauri";
import {
  formatQrCleanupSummary,
  type QrCleanupResult,
} from "@/lib/qrCleanup";
import type { DialogOptions } from "@/store/uiStore";

export const QR_SUCCESS_TITLE = "QR-Code erkannt";

export function kundeDisplayName(
  kunde: Pick<Kunde, "vorname" | "nachname"> | null | undefined,
): string {
  if (!kunde) return "";
  return [kunde.vorname, kunde.nachname].filter(Boolean).join(" ").trim();
}

export function fileBaseName(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/^.*[/\\]/, "");
}

export type FormatQrSuccessInput = {
  kunde?: Pick<Kunde, "vorname" | "nachname"> | null;
  cleanup?: QrCleanupResult;
  sourcePath?: string | null;
  /** Extra detail lines (e.g. "Datei nicht importiert.") */
  notes?: string[];
};

/** Build title, body and QR-variant options for SuccessDialog. */
export function formatQrSuccess(input: FormatQrSuccessInput): {
  title: string;
  message: string;
  options: DialogOptions;
} {
  const name = kundeDisplayName(input.kunde);
  const lines: string[] = [
    name
      ? "Kundendaten wurden aus dem QR-Code übernommen."
      : "QR-Code erkannt und Kundendaten übernommen.",
  ];
  const src = fileBaseName(input.sourcePath);
  if (src) lines.push(`Quelle: ${src}`);
  for (const note of input.notes ?? []) {
    const trimmed = note.trim();
    if (trimmed) lines.push(trimmed);
  }
  const cleanup = input.cleanup
    ? formatQrCleanupSummary(input.cleanup).replace(/^\n/, "").trim()
    : "";
  if (cleanup) lines.push(cleanup);

  return {
    title: QR_SUCCESS_TITLE,
    message: lines.join("\n"),
    options: {
      variant: "qr",
      highlight: name || "Kunde erkannt",
      autoCloseSecs: 5,
    },
  };
}
