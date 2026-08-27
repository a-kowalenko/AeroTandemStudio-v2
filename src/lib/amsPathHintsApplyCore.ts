/** Pure apply + credential-matrix helpers (Node-testable). */

import {
  AMS_BACKUP_PROFILE_ID,
  type AmsPathHints,
  type PathHintsConfigWire,
  type ServerProfileWire,
} from "./amsPathHintsCore.ts";

export type CredentialProbeResult = {
  primaryOk: boolean;
  /** `null` when no backup URL to test. */
  backupOk: boolean | null;
};

export type CredentialPromptPlan =
  | "none"
  | "primary"
  | "backup"
  | "primary_then_maybe_backup";

export function upsertAmsBackupProfileWire(
  profiles: ServerProfileWire[] | undefined,
  backupUrl: string,
  label: string,
): ServerProfileWire[] {
  if (!backupUrl.trim()) return [...(profiles ?? [])];
  const next = [...(profiles ?? [])];
  const idx = next.findIndex((p) => p.id === AMS_BACKUP_PROFILE_ID);
  if (idx >= 0) {
    next[idx] = { ...next[idx]!, url: backupUrl };
    return next;
  }
  next.push({
    id: AMS_BACKUP_PROFILE_ID,
    url: backupUrl,
    label,
    login: "",
    password: "",
  });
  return next;
}

/** Apply AMS hints to config wire (primary → flat url; backup → `ams-backup` profile). */
export function applyPathHintsToConfigWire(
  config: PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
    active_server_profile_id?: string;
  },
  hints: AmsPathHints,
  backupProfileLabel: string,
): PathHintsConfigWire & {
  server_login?: string;
  server_password?: string;
  active_server_profile_id?: string;
  server_profiles?: ServerProfileWire[];
} {
  const profiles = [...(config.server_profiles ?? [])];
  const activeId = config.active_server_profile_id ?? "default";
  const activeIdx = profiles.findIndex((p) => p.id === activeId);
  if (activeIdx >= 0) {
    profiles[activeIdx] = { ...profiles[activeIdx]!, url: hints.primarySmbUrl };
  }

  const withBackup = hints.backupSmbUrl
    ? upsertAmsBackupProfileWire(profiles, hints.backupSmbUrl, backupProfileLabel)
    : profiles;

  return {
    ...config,
    server_url: hints.primarySmbUrl,
    server_profiles: withBackup,
  };
}

export function copyPrimaryCredsToBackupProfileWire<
  T extends PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
  },
>(config: T): T {
  const profiles = [...(config.server_profiles ?? [])];
  const idx = profiles.findIndex((p) => p.id === AMS_BACKUP_PROFILE_ID);
  if (idx < 0) return config;
  profiles[idx] = {
    ...profiles[idx]!,
    login: config.server_login ?? "",
    password: config.server_password ?? "",
  };
  return { ...config, server_profiles: profiles };
}

export function patchBackupProfileCredsWire<
  T extends PathHintsConfigWire,
>(config: T, login: string, password: string): T {
  const profiles = [...(config.server_profiles ?? [])];
  const idx = profiles.findIndex((p) => p.id === AMS_BACKUP_PROFILE_ID);
  if (idx < 0) return config;
  profiles[idx] = { ...profiles[idx]!, login, password };
  return { ...config, server_profiles: profiles };
}

export function patchPrimaryCredsWire<
  T extends PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
    active_server_profile_id?: string;
  },
>(config: T, login: string, password: string): T {
  const profiles = [...(config.server_profiles ?? [])];
  const activeId = config.active_server_profile_id ?? "default";
  const idx = profiles.findIndex((p) => p.id === activeId);
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx]!, login, password };
  }
  return {
    ...config,
    server_login: login,
    server_password: password,
    server_profiles: profiles,
  };
}

/** Decide which credential prompts to show after SMB probes (HANDOFF §9.3). */
export function credentialPromptPlan(
  probe: CredentialProbeResult,
  hasBackup: boolean,
): CredentialPromptPlan {
  const { primaryOk, backupOk } = probe;
  if (primaryOk && (!hasBackup || backupOk === true)) return "none";
  if (primaryOk && backupOk === false) return "backup";
  if (!primaryOk && backupOk === true) return "primary";
  if (!primaryOk && backupOk === false) return "primary_then_maybe_backup";
  if (!primaryOk && backupOk === null) return "primary";
  return "none";
}
