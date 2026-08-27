import { tr } from "@/i18n";
import type { AppConfig } from "@/lib/tauri";
import { findBackupServerProfile } from "@/lib/amsPathHints";
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
  upsertAmsBackupProfileWire,
  type CredentialProbeResult,
  type CredentialPromptPlan,
} from "@/lib/amsPathHintsApplyCore";

export function backupProfileDefaultLabel(): string {
  return tr("settings.server.pathHints.backupProfileLabel");
}

export function applyPathHintsToConfig(
  config: AppConfig,
  hints: AmsPathHints,
): AppConfig {
  return applyPathHintsToConfigWire(
    config,
    hints,
    backupProfileDefaultLabel(),
  ) as AppConfig;
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
  return findBackupServerProfile(config.server_profiles)?.url?.trim() ?? "";
}

export function backupCredsFromConfig(config: AppConfig): {
  login: string;
  password: string;
} {
  const profile = findBackupServerProfile(config.server_profiles);
  return {
    login: profile?.login?.trim() ?? config.server_login?.trim() ?? "",
    password: profile?.password ?? config.server_password ?? "",
  };
}
