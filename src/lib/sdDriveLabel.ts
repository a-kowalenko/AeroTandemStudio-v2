/** Display helpers for SD drive paths / volume labels. */

import type { SdDriveInfo } from "./sdCard";

const GENERIC_VOLUME_NAMES = new Set([
  "no name",
  "untitled",
  "removable disk",
  "wechseldatenträger",
  "neuer datenträger",
  "unbenannt",
]);

export function isWindowsDriveLetter(drive: string): boolean {
  return /^[A-Za-z]:\\?$/.test(drive.trim());
}

/** Prefer the volume name on Unix mounts for a compact macOS-like row. */
export function driveBasename(drive: string): string {
  const trimmed = drive.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  if (parts.length > 1 && (trimmed.startsWith("/") || trimmed.includes("\\"))) {
    return parts[parts.length - 1] || drive;
  }
  return drive.replace(/\\+$/, "");
}

export function isGenericVolumeName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return !n || GENERIC_VOLUME_NAMES.has(n);
}

/** Extra volume label for Windows letters when it adds disambiguation. */
export function usefulVolumeName(
  drive: string,
  volumeName: string | undefined,
): string | null {
  const vol = volumeName?.trim() ?? "";
  if (!vol || isGenericVolumeName(vol)) return null;
  const primary = isWindowsDriveLetter(drive)
    ? drive.replace(/\\+$/, "")
    : driveBasename(drive);
  if (vol.toLowerCase() === primary.toLowerCase()) return null;
  // On Unix the basename already is the volume name — avoid duplication.
  if (!isWindowsDriveLetter(drive)) return null;
  return vol;
}

/** Compact closed-trigger label (letter or Unix basename). */
export function compactDriveLabel(drive: string): string {
  if (drive.startsWith("mtp:")) {
    // mtp:gopro:serial → show vendor slug until volume_name is applied by callers
    const parts = drive.split(":");
    const slug = parts[1] || "usb";
    if (slug === "gopro") return "GoPro (USB)";
    if (slug === "dji") return "DJI (USB)";
    if (slug === "insta360") return "Insta360 (USB)";
    return `${slug} (USB)`;
  }
  if (isWindowsDriveLetter(drive)) return drive.replace(/\\+$/, "");
  return driveBasename(drive);
}

/** Plain-text list label for aria / titles. */
export function listDriveLabel(info: Pick<SdDriveInfo, "drive" | "volume_name">): string {
  if (info.drive.startsWith("mtp:") && info.volume_name?.trim()) {
    return info.volume_name.trim();
  }
  const primary = compactDriveLabel(info.drive);
  const vol = usefulVolumeName(info.drive, info.volume_name);
  return vol ? `${primary} ${vol}` : primary;
}

export function driveTooltip(info: Pick<SdDriveInfo, "drive" | "volume_name">): string {
  if (info.drive.startsWith("mtp:")) {
    const label = info.volume_name?.trim() || compactDriveLabel(info.drive);
    return `${label} — ${info.drive}`;
  }
  const vol = usefulVolumeName(info.drive, info.volume_name);
  if (vol) return `${compactDriveLabel(info.drive)} — ${vol}`;
  return info.drive;
}
