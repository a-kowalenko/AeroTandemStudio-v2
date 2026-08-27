/** Pure AMS path-hint helpers (no app imports — testable under Node). */

export const DEFAULT_SERVER_URL = "smb://169.254.169.254/aktuell";

/** Capability advertised when AMS publishes non-empty `ats_paths.primary_smb_url`. */
export const PATHS_V1_CAPABILITY = "paths-v1";

/** Second server profile id for AMS backup hint (Phase 35.b applies). */
export const AMS_BACKUP_PROFILE_ID = "ams-backup";

export type AmsPathHints = {
  primarySmbUrl: string;
  backupSmbUrl: string;
};

export type AmsPathHintsDiffKind =
  | "none"
  | "suggest"
  | "drift"
  | "match";

export type AmsPathHintsDiff = {
  kind: AmsPathHintsDiffKind;
  /** Bridge connected and `paths-v1` with a primary hint. */
  available: boolean;
  hints: AmsPathHints | null;
  /** Normalized active `server_url`. */
  currentPrimary: string;
  /** Normalized backup profile URL (empty when profile missing). */
  currentBackup: string;
};

export type AmsBridgeAtsPathsWire = {
  primary_smb_url?: string | null;
  backup_smb_url?: string | null;
};

export type AmsBridgeHealthWire = {
  capabilities?: string[];
  ats_paths?: AmsBridgeAtsPathsWire | null;
};

export type ServerProfileWire = {
  id: string;
  url?: string;
  label?: string;
  login?: string;
  password?: string;
  backup_url?: string;
  backup_login?: string;
  backup_password?: string;
};

export type PathHintsConfigWire = {
  server_url?: string;
  active_server_profile_id?: string;
  server_profiles?: ServerProfileWire[];
};

/** True when URL is empty or the factory default placeholder. */
export function isPlaceholderServerUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return (
    normalizeSmbUrlForCompare(trimmed) ===
    normalizeSmbUrlForCompare(DEFAULT_SERVER_URL)
  );
}

/**
 * Normalize SMB URLs for equality checks (HANDOFF §9.3 wire format).
 * UNC / `//` → `smb://`; backslashes → forward slashes; scheme lower-case.
 */
export function normalizeSmbUrlForCompare(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower.startsWith("smb://")) {
    return `smb://${t.slice(6).replace(/\\/g, "/")}`;
  }
  if (t.startsWith("\\\\")) {
    return `smb://${t.slice(2).replace(/\\/g, "/")}`;
  }
  if (t.startsWith("//")) {
    return `smb://${t.slice(2).replace(/\\/g, "/")}`;
  }
  return t;
}

export function hasPathsV1Capability(capabilities: string[] | undefined): boolean {
  return (capabilities ?? []).includes(PATHS_V1_CAPABILITY);
}

/** Extract client hints from health when `paths-v1` is advertised. */
export function parsePathHintsFromHealth(
  health: AmsBridgeHealthWire | null | undefined,
): AmsPathHints | null {
  if (!health || !hasPathsV1Capability(health.capabilities)) {
    return null;
  }
  const wire = health.ats_paths;
  const primaryRaw = wire?.primary_smb_url?.trim() ?? "";
  if (!primaryRaw) return null;
  const backupRaw = wire?.backup_smb_url?.trim() ?? "";
  return {
    primarySmbUrl: normalizeSmbUrlForCompare(primaryRaw),
    backupSmbUrl: backupRaw ? normalizeSmbUrlForCompare(backupRaw) : "",
  };
}

export function backupProfileUrlFromProfiles(
  profiles: ServerProfileWire[] | undefined,
  activeId?: string,
): string {
  const list = profiles ?? [];
  const active =
    (activeId && list.find((p) => p.id === activeId)) ||
    list.find((p) => p.id === "default") ||
    list[0];
  const fromActive = active?.backup_url?.trim() ?? "";
  if (fromActive) return fromActive;
  // Legacy Phase 35: standalone ams-backup profile
  const legacy = list.find((p) => p.id === AMS_BACKUP_PROFILE_ID);
  return legacy?.url?.trim() ?? "";
}

/** True when any saved profile already has the AMS primary (+ backup if hinted). */
export function anyProfileMatchesPathHints(
  profiles: ServerProfileWire[] | undefined,
  hints: AmsPathHints,
): boolean {
  const primary = hints.primarySmbUrl;
  if (!primary) return false;
  const needBackup = Boolean(hints.backupSmbUrl);
  for (const profile of profiles ?? []) {
    if (profile.id === AMS_BACKUP_PROFILE_ID) continue;
    const url = normalizeSmbUrlForCompare(profile.url ?? "");
    if (url !== primary) continue;
    if (!needBackup) return true;
    const backup = normalizeSmbUrlForCompare(profile.backup_url ?? "");
    if (backup === hints.backupSmbUrl) return true;
  }
  return false;
}

/** Compare current SMB config against AMS path hints (no side effects). */
export function computePathHintsDiff(
  config: PathHintsConfigWire,
  hints: AmsPathHints | null,
): AmsPathHintsDiff {
  const currentPrimary = normalizeSmbUrlForCompare(config.server_url ?? "");
  const currentBackup = normalizeSmbUrlForCompare(
    backupProfileUrlFromProfiles(
      config.server_profiles,
      config.active_server_profile_id,
    ),
  );

  if (!hints?.primarySmbUrl) {
    return {
      kind: "none",
      available: false,
      hints: null,
      currentPrimary,
      currentBackup,
    };
  }

  const primaryMatch = currentPrimary === hints.primarySmbUrl;
  const backupMatch =
    !hints.backupSmbUrl ||
    currentBackup === hints.backupSmbUrl ||
    (!currentBackup && !hints.backupSmbUrl);

  let kind: AmsPathHintsDiffKind;
  if (
    isPlaceholderServerUrl(config.server_url ?? "") &&
    anyProfileMatchesPathHints(config.server_profiles, hints)
  ) {
    // Creating/placeholder active, but another profile already has AMS paths.
    kind = "match";
  } else if (isPlaceholderServerUrl(config.server_url ?? "")) {
    kind = "suggest";
  } else if (!primaryMatch || !backupMatch) {
    kind = "drift";
  } else {
    kind = "match";
  }

  return {
    kind,
    available: true,
    hints,
    currentPrimary,
    currentBackup,
  };
}

/** Build diff from a health payload + config (store / poll helper). */
export function diffPathHintsFromHealth(
  config: PathHintsConfigWire,
  health: AmsBridgeHealthWire | null | undefined,
): AmsPathHintsDiff {
  return computePathHintsDiff(config, parsePathHintsFromHealth(health));
}

/** Whether backup hint differs from the active profile's backup_url. */
export function backupHintDrift(
  hints: AmsPathHints,
  config: PathHintsConfigWire,
): boolean {
  if (!hints.backupSmbUrl) return false;
  const current = normalizeSmbUrlForCompare(
    backupProfileUrlFromProfiles(
      config.server_profiles,
      config.active_server_profile_id,
    ),
  );
  return current !== hints.backupSmbUrl;
}

/** Which parts differ when `kind === "drift"` (for 35.c banner copy). */
export function pathHintsDriftFacets(diff: AmsPathHintsDiff): {
  primary: boolean;
  backup: boolean;
} {
  if (diff.kind !== "drift" || !diff.hints) {
    return { primary: false, backup: false };
  }
  const primary = diff.currentPrimary !== diff.hints.primarySmbUrl;
  const backup = Boolean(
    diff.hints.backupSmbUrl &&
      diff.currentBackup !== diff.hints.backupSmbUrl,
  );
  return { primary, backup };
}

/** Stable key for AMS hint payload (detect hint changes after dismiss). */
export function pathHintsHintsSignature(hints: AmsPathHints): string {
  return `${hints.primarySmbUrl}\0${hints.backupSmbUrl}`;
}

/**
 * Drift signature: normalized AMS primary+backup vs current config primary+backup.
 * Returns empty when not drift.
 */
export function pathHintsDriftSignature(diff: AmsPathHintsDiff): string {
  if (diff.kind !== "drift" || !diff.hints) return "";
  return `${diff.hints.primarySmbUrl}\0${diff.hints.backupSmbUrl}\0${diff.currentPrimary}\0${diff.currentBackup}`;
}

export type PathHintsDriftDismissState = {
  driftKey: string;
  hintsKey: string;
};

/** Build dismiss payload for the current drift diff. */
export function buildPathHintsDriftDismissState(
  diff: AmsPathHintsDiff,
): PathHintsDriftDismissState | null {
  if (diff.kind !== "drift" || !diff.hints) return null;
  const driftKey = pathHintsDriftSignature(diff);
  if (!driftKey) return null;
  return {
    driftKey,
    hintsKey: pathHintsHintsSignature(diff.hints),
  };
}

/**
 * True when drift banner should stay hidden after „Später“ until hints or config change.
 */
export function shouldSuppressPathHintsDriftBanner(
  diff: AmsPathHintsDiff,
  dismissed: PathHintsDriftDismissState | null | undefined,
): boolean {
  if (diff.kind !== "drift" || !diff.hints) return true;
  if (!dismissed) return false;
  const driftKey = pathHintsDriftSignature(diff);
  const hintsKey = pathHintsHintsSignature(diff.hints);
  if (dismissed.hintsKey !== hintsKey) return false;
  if (dismissed.driftKey !== driftKey) return false;
  return true;
}

/**
 * HANDOFF §9.3: apply only when live instance is unknown or matches saved binding.
 * `liveServerInstanceId` = AMS health `instance_id`; `configServerInstanceId` = `ams_bridge_server_instance_id`.
 */
export function pathHintsApplyInstanceAllowed(
  configServerInstanceId: string | undefined,
  liveServerInstanceId: string | undefined,
): boolean {
  const live = (liveServerInstanceId ?? "").trim();
  if (!live) return true;
  const saved = (configServerInstanceId ?? "").trim();
  if (!saved) return true;
  return saved === live;
}

/** Persist AMS instance binding after successful path-hints apply. */
export function bindPathHintsServerInstance<
  T extends { ams_bridge_server_instance_id?: string },
>(config: T, liveServerInstanceId: string | undefined): T {
  const live = (liveServerInstanceId ?? "").trim();
  if (!live) return config;
  return { ...config, ams_bridge_server_instance_id: live };
}
