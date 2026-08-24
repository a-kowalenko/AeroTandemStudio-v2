import { tr } from "@/i18n";

/** Rust `get_updater_install_hint` messages → i18n keys. */
const UPDATER_INSTALL_HINT_KEY_MAP: Record<string, string> = {
  "Für automatische Updates sollte die App im Ordner „Programme“ liegen.":
    "app.update.installHintMacApplications",
  "Automatische Updates funktionieren zuverlässig nur als AppImage.":
    "app.update.installHintLinuxAppImage",
};

/** Translate known Rust updater install hints for display. */
export function presentUpdaterInstallHint(hint: string | null): string | null {
  if (!hint?.trim()) return null;
  const key = UPDATER_INSTALL_HINT_KEY_MAP[hint.trim()];
  return key ? tr(key) : hint;
}
