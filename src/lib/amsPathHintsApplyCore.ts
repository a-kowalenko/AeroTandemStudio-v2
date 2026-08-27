/** Pure apply + credential-matrix helpers (Node-testable). */

import {
  AMS_BACKUP_PROFILE_ID,
  normalizeSmbUrlForCompare,
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

function activeProfileIndex(
  profiles: ServerProfileWire[],
  activeId: string,
): number {
  return profiles.findIndex((p) => p.id === activeId);
}

/** Drop legacy standalone `ams-backup` profile (backup lives on each profile). */
export function stripLegacyAmsBackupProfileWire(
  profiles: ServerProfileWire[] | undefined,
): ServerProfileWire[] {
  return (profiles ?? []).filter((p) => p.id !== AMS_BACKUP_PROFILE_ID);
}

function normalizeUrl(url: string | undefined): string {
  return normalizeSmbUrlForCompare((url ?? "").trim());
}

/** Find a non-legacy profile that already has the AMS primary (+ backup if hinted). */
export function findProfileMatchingPathHints(
  profiles: ServerProfileWire[] | undefined,
  hints: AmsPathHints,
): ServerProfileWire | undefined {
  const primary = normalizeUrl(hints.primarySmbUrl);
  if (!primary) return undefined;
  const needBackup = Boolean(hints.backupSmbUrl);
  for (const profile of profiles ?? []) {
    if (profile.id === AMS_BACKUP_PROFILE_ID) continue;
    if (normalizeUrl(profile.url) !== primary) continue;
    if (!needBackup) return profile;
    if (normalizeUrl(profile.backup_url) === normalizeUrl(hints.backupSmbUrl)) {
      return profile;
    }
  }
  return undefined;
}

function uniqueProfileLabel(
  profiles: ServerProfileWire[],
  base: string,
): string {
  const root = base.trim() || "AMS";
  const names = new Set(profiles.map((p) => (p.label ?? "").trim()));
  if (!names.has(root)) return root;
  let n = 2;
  while (names.has(`${root} ${n}`)) n += 1;
  return `${root} ${n}`;
}

function newServerProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ams-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Apply AMS hints: activate a matching profile if one exists, otherwise
 * create a new profile and activate it. Existing profiles are left intact
 * (only legacy `ams-backup` is stripped).
 */
export function applyPathHintsToConfigWire(
  config: PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
    active_server_profile_id?: string;
    ams_bridge_display_name?: string;
  },
  hints: AmsPathHints,
  profileLabel?: string,
): PathHintsConfigWire & {
  server_login?: string;
  server_password?: string;
  active_server_profile_id?: string;
  server_profiles?: ServerProfileWire[];
} {
  const profiles = stripLegacyAmsBackupProfileWire(config.server_profiles);
  const existing = findProfileMatchingPathHints(profiles, hints);
  if (existing) {
    return {
      ...config,
      server_profiles: profiles,
      active_server_profile_id: existing.id,
      server_url: existing.url ?? hints.primarySmbUrl,
      server_login: existing.login ?? config.server_login ?? "",
      server_password: existing.password ?? config.server_password ?? "",
    };
  }

  const label = uniqueProfileLabel(
    profiles,
    profileLabel?.trim() ||
      config.ams_bridge_display_name?.trim() ||
      "AMS",
  );
  const id = newServerProfileId();
  const fresh: ServerProfileWire = {
    id,
    label,
    url: hints.primarySmbUrl,
    backup_url: hints.backupSmbUrl || "",
    login: config.server_login ?? "",
    password: config.server_password ?? "",
    backup_login: "",
    backup_password: "",
  };
  profiles.push(fresh);

  return {
    ...config,
    server_profiles: profiles,
    active_server_profile_id: id,
    server_url: fresh.url,
    server_login: fresh.login ?? "",
    server_password: fresh.password ?? "",
  };
}

export function copyPrimaryCredsToBackupProfileWire<
  T extends PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
    active_server_profile_id?: string;
  },
>(config: T): T {
  const profiles = [...(config.server_profiles ?? [])];
  const activeId = config.active_server_profile_id ?? "default";
  const idx = activeProfileIndex(profiles, activeId);
  if (idx < 0) return config;
  const profile = profiles[idx]!;
  if (!(profile.backup_url ?? "").trim()) return config;
  profiles[idx] = {
    ...profile,
    backup_login: config.server_login ?? "",
    backup_password: config.server_password ?? "",
  };
  return { ...config, server_profiles: profiles };
}

export function patchBackupProfileCredsWire<
  T extends PathHintsConfigWire & {
    active_server_profile_id?: string;
  },
>(config: T, login: string, password: string): T {
  const profiles = [...(config.server_profiles ?? [])];
  const activeId = config.active_server_profile_id ?? "default";
  const idx = activeProfileIndex(profiles, activeId);
  if (idx < 0) return config;
  profiles[idx] = {
    ...profiles[idx]!,
    backup_login: login,
    backup_password: password,
  };
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
  const idx = activeProfileIndex(profiles, activeId);
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

const WIZARD_PRESET_PROFILE_IDS = new Set(["default", "gera"]);

/**
 * After AMS path apply in the wizard: drop unused Calden/Gera presets.
 * Keeps the active profile and any other non-preset profiles.
 */
export function pruneWizardPresetsAfterPathApplyWire<
  T extends PathHintsConfigWire & {
    server_login?: string;
    server_password?: string;
    active_server_profile_id?: string;
  },
>(config: T): T {
  const activeId = config.active_server_profile_id ?? "default";
  const before = stripLegacyAmsBackupProfileWire(config.server_profiles);
  const profiles = before.filter((p) => {
    if (p.id === activeId) return true;
    if (WIZARD_PRESET_PROFILE_IDS.has(p.id)) return false;
    return true;
  });
  if (profiles.length === 0) return { ...config, server_profiles: before };
  if (
    profiles.length === before.length &&
    profiles.every((p, i) => p.id === before[i]?.id)
  ) {
    return config;
  }

  const nextActive = profiles.some((p) => p.id === activeId)
    ? activeId
    : profiles[0]!.id;
  const target = profiles.find((p) => p.id === nextActive);
  if (!target) return config;
  return {
    ...config,
    server_profiles: profiles,
    active_server_profile_id: nextActive,
    server_url: target.url,
    server_login: target.login ?? config.server_login,
    server_password: target.password ?? config.server_password,
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
