/** Map Rust SD/backup/clear user-facing strings → i18n. */

import { tr } from "@/i18n";
import {
  emptyCatalogLabel,
  isEmptyCatalogMessage,
  isMtpDrive,
  type ListEmptyReason,
} from "@/lib/sdCard";

const EXACT: Record<string, string> = {
  "Backup läuft bereits": "sd.messages.backupAlreadyRunning",
  "Kein Laufwerk angegeben": "sd.messages.noDrive",
  "USB-Kamera-Import ist in den Einstellungen deaktiviert.":
    "sd.messages.usbImportDisabled",
  "SD-Bereinigung ist nur nach erfolgreichem Backup erlaubt":
    "sd.messages.clearOnlyAfterBackup",
  "Nicht bereinigt (keine Dateien im Backup).":
    "sd.messages.notClearedNoFilesInBackup",
  "Kamera-Bereinigung meldete Erfolg, aber es wurde nichts gelöscht.":
    "sd.messages.clearReportedOkButNothingDeleted",
  "USB-Kamera freigegeben. Bitte Kabel trennen; erst nach erneutem Anstecken wieder importieren.":
    "sd.messages.usbReleased",
  "Kopierstrategie „Direkt“ ist veraltet — Server-Spiegel läuft im Hintergrund (lokal zuerst).":
    "sd.messages.directCopyDeprecated",
  "Server-Backup-URL fehlt": "sd.messages.serverBackupUrlMissingShort",
  "Server-Backup-URL fehlt (Primär bleibt erfolgreich) — bitte smb://… im Server-Profil setzen.":
    "sd.messages.serverBackupUrlMissing",
};

const PREFIX: { prefix: string; key: string; keepSuffix?: boolean }[] = [
  {
    prefix: "Ungültiger Backup-Ordner: ",
    key: "sd.messages.invalidBackupFolder",
    keepSuffix: true,
  },
  {
    prefix: "DCIM nicht gefunden: ",
    key: "sd.messages.dcimNotFound",
    keepSuffix: true,
  },
  {
    prefix: "DCIM Ordner nicht gefunden: ",
    key: "sd.messages.dcimNotFound",
    keepSuffix: true,
  },
  {
    prefix: "Keine neuen Dateien zum Sichern. Übersprungen: ",
    key: "sd.messages.noNewFilesToBackup",
    keepSuffix: true,
  },
  {
    prefix: "SD-Karte wurde während des Backups entfernt: ",
    key: "sd.messages.sdRemovedDuringBackup",
    keepSuffix: true,
  },
  {
    prefix: "Server-Backup-URL ungültig (Primär bleibt erfolgreich): ",
    key: "sd.messages.serverBackupUrlInvalid",
    keepSuffix: true,
  },
  {
    prefix: "Server-Backup fehlgeschlagen (Primär bleibt erfolgreich): ",
    key: "sd.messages.serverBackupFailedPrimaryOk",
    keepSuffix: true,
  },
  {
    prefix: "Kamera-Bereinigung fehlgeschlagen: ",
    key: "sd.messages.cameraClearFailed",
    keepSuffix: true,
  },
  {
    prefix: "Lokaler Backup-Ordner fehlt: ",
    key: "sd.messages.localBackupFolderMissing",
    keepSuffix: true,
  },
];

export function emptyReasonFromMessage(msg: string): ListEmptyReason {
  if (
    /importierbaren Medien|Timelapse|Proxies|filtered/i.test(msg)
  ) {
    return "filtered_only";
  }
  return "no_media";
}

/** Present empty-catalog Rust message with drive-aware i18n label. */
export function presentEmptyCatalogMessage(
  msg: string,
  drive?: string | null,
): string {
  return emptyCatalogLabel(drive, emptyReasonFromMessage(msg));
}

/**
 * Translate known SD / backup / clear strings for toasts and status details.
 * Unknown messages (incl. long soft-fail paragraphs) stay as-is.
 */
export function presentSdUserMessage(
  raw: string | null | undefined,
  opts?: { drive?: string | null },
): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "";

  if (isEmptyCatalogMessage(msg)) {
    return presentEmptyCatalogMessage(msg, opts?.drive);
  }

  const exactKey = EXACT[msg];
  if (exactKey) return tr(exactKey);

  for (const { prefix, key, keepSuffix } of PREFIX) {
    if (msg.startsWith(prefix)) {
      const detail = msg.slice(prefix.length).trim();
      if (keepSuffix && detail) {
        return tr(key, { detail });
      }
      return tr(key);
    }
  }

  const usbCleared = /^USB-Kamera bereinigt \((\d+) Datei\(en\)\)\.$/.exec(msg);
  if (usbCleared) {
    return tr("sd.messages.usbCleared", { count: Number(usbCleared[1]) });
  }

  if (msg.startsWith("Backup ist gespeichert. Kamera-Bereinigung über USB nicht möglich")) {
    return tr("sd.messages.usbClearSoftFail");
  }

  // Generic MTP empty without exact catalog match
  if (/Keine Medien auf der Kamera gefunden/i.test(msg)) {
    return emptyCatalogLabel(opts?.drive ?? "mtp:", "no_media");
  }
  if (/Keine Mediendateien auf der/i.test(msg)) {
    return emptyCatalogLabel(
      isMtpDrive(opts?.drive) ? opts?.drive : null,
      "no_media",
    );
  }

  return msg;
}
