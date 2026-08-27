import { tr } from "@/i18n";
import type { AppConfig } from "@/lib/tauri";
import { getActiveServerProfile } from "@/lib/serverProfile";
import type { AmsPathHints } from "@/lib/amsPathHintsCore";
import {
  applyPathHintsToConfigWire,
  copyPrimaryCredsToBackupProfileWire,
  patchBackupProfileCredsWire,
  patchPrimaryCredsWire,
} from "@/lib/amsPathHintsApplyCore";

export {
  applyPathHintsToConfigWire,
  copyPrimaryCredsToBackupProfileWire,
  credentialPromptPlan,
  patchBackupProfileCredsWire,
  patchPrimaryCredsWire,
  pruneWizardPresetsAfterPathApplyWire,
  stripLegacyAmsBackupProfileWire,
  type CredentialProbeResult,
  type CredentialPromptPlan,
} from "@/lib/amsPathHintsApplyCore";

export function pathHintsProfileDefaultLabel(): string {
  return tr("settings.server.pathHints.newProfileLabel");
}

/** @deprecated Use pathHintsProfileDefaultLabel */
export function backupProfileDefaultLabel(): string {
  return tr("settings.server.pathHints.backupProfileLabel");
}

export function applyPathHintsToConfig(
  config: AppConfig,
  hints: AmsPathHints,
  profileLabel?: string,
): AppConfig {
  const label =
    profileLabel?.trim() ||
    config.ams_bridge_display_name?.trim() ||
    pathHintsProfileDefaultLabel();
  return applyPathHintsToConfigWire(config, hints, label) as AppConfig;
}

export function copyPrimaryCredsToBackupProfile(config: AppConfig): AppConfig {
  return copyPrimaryCredsToBackupProfileWire(config) as AppConfig;
}

export function patchBackupProfileCreds(
  config: AppConfig,
  login: string,
  password: string,
): AppConfig {
  return patchBackupProfileCredsWire(config, login, password) as AppConfig;
}

export function patchPrimaryCreds(
  config: AppConfig,
  login: string,
  password: string,
): AppConfig {
  return patchPrimaryCredsWire(config, login, password) as AppConfig;
}

export function backupUrlFromConfig(config: AppConfig): string {
  return getActiveServerProfile(config)?.backup_url?.trim() ?? "";
}

export function backupCredsFromConfig(config: AppConfig): {
  login: string;
  password: string;
} {
  const profile = getActiveServerProfile(config);
  const backupLogin = profile?.backup_login?.trim() ?? "";
  const backupPassword = profile?.backup_password ?? "";
  if (backupLogin || backupPassword) {
    return { login: backupLogin, password: backupPassword };
  }
  return {
    login: config.server_login?.trim() ?? "",
    password: config.server_password ?? "",
  };
}
