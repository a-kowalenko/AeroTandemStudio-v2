import type { AppConfig } from "@/lib/tauri";
import { tr } from "@/i18n";

export const DEFAULT_SERVER_PROFILE_ID = "default";
export const GERA_SERVER_PROFILE_ID = "gera";
export const DEFAULT_SERVER_URL = "smb://169.254.169.254/aktuell";

export const PRESET_SERVER_PROFILE_LABELS = {
  calden: "Video-PC Calden",
  gera: "Video-PC Gera",
} as const;

const PRESET_CALDEN_PROFILE: ServerProfile = {
  id: DEFAULT_SERVER_PROFILE_ID,
  label: PRESET_SERVER_PROFILE_LABELS.calden,
  url: DEFAULT_SERVER_URL,
  login: "",
  password: "",
};

const PRESET_GERA_PROFILE: ServerProfile = {
  id: GERA_SERVER_PROFILE_ID,
  label: PRESET_SERVER_PROFILE_LABELS.gera,
  url: "",
  login: "",
  password: "",
};

export type ServerProfile = {
  id: string;
  label: string;
  url: string;
  login: string;
  password: string;
};

export function findServerProfile(
  profiles: ServerProfile[] | undefined,
  id: string,
): ServerProfile | undefined {
  return (profiles ?? []).find((p) => p.id === id);
}

export function getActiveServerProfile(
  config: AppConfig,
): ServerProfile | undefined {
  return findServerProfile(
    config.server_profiles,
    config.active_server_profile_id,
  );
}

export function displayServerProfileLabel(profile: ServerProfile): string {
  const label = profile.label.trim();
  if (label) return label;
  const url = profile.url.trim();
  if (url) return url;
  return profile.id;
}

export function displayServerProfileSubtitle(profile: ServerProfile): string {
  const url = profile.url.trim();
  if (url) return url;
  return "";
}

export function serverUrlToDialogDefaultPath(serverUrl: string): string | undefined {
  const raw = serverUrl.trim();
  if (!raw) return undefined;
  if (raw.toLowerCase().startsWith("smb://")) {
    let rest = raw.slice(6);
    if (rest.includes("@")) {
      rest = rest.split("@").slice(1).join("@");
    }
    rest = rest.replace(/\//g, "\\");
    return `\\\\${rest.replace(/^\\+/, "")}`;
  }
  if (raw.startsWith("//")) return `\\${raw}`;
  return raw;
}

/** Prefix options for the server-URL field (matches SMB client accept list). */
export type ServerUrlScheme = "smb://" | "\\\\" | "//" | "path";

export const SERVER_URL_SCHEME_OPTIONS: ReadonlyArray<{
  id: ServerUrlScheme;
  prefix: string;
}> = [
  { id: "smb://", prefix: "smb://" },
  { id: "\\\\", prefix: "\\\\" },
  { id: "//", prefix: "//" },
  { id: "path", prefix: "" },
];

export function parseServerUrlParts(url: string): {
  scheme: ServerUrlScheme;
  rest: string;
} {
  const raw = url.trim();
  if (!raw) return { scheme: "smb://", rest: "" };
  const lower = raw.toLowerCase();
  if (lower.startsWith("smb://")) {
    return { scheme: "smb://", rest: raw.slice(6) };
  }
  if (raw.startsWith("\\\\")) {
    return { scheme: "\\\\", rest: raw.slice(2) };
  }
  if (raw.startsWith("//")) {
    return { scheme: "//", rest: raw.slice(2) };
  }
  return { scheme: "path", rest: raw };
}

export function composeServerUrl(scheme: ServerUrlScheme, rest: string): string {
  const body = rest.trim();
  if (!body) return "";
  switch (scheme) {
    case "smb://":
      return `smb://${body.replace(/^\/+/, "")}`;
    case "\\\\":
      return `\\\\${body.replace(/^\\+/, "")}`;
    case "//":
      return `//${body.replace(/^\/+/, "")}`;
    case "path":
      return body;
  }
}

export function pushFlatToActiveProfile(config: AppConfig): AppConfig {
  const profiles = [...(config.server_profiles ?? [])];
  const idx = profiles.findIndex(
    (p) => p.id === config.active_server_profile_id,
  );
  if (idx < 0) return config;
  profiles[idx] = {
    ...profiles[idx],
    url: config.server_url,
    login: config.server_login,
    password: config.server_password,
  };
  return { ...config, server_profiles: profiles };
}

export function patchServerConnection(
  config: AppConfig,
  patch: Partial<{ url: string; login: string; password: string }>,
): AppConfig {
  const next: AppConfig = {
    ...config,
    ...(patch.url !== undefined ? { server_url: patch.url } : {}),
    ...(patch.login !== undefined ? { server_login: patch.login } : {}),
    ...(patch.password !== undefined
      ? { server_password: patch.password }
      : {}),
  };
  return pushFlatToActiveProfile(next);
}

export function patchActiveServerProfileLabel(
  config: AppConfig,
  label: string,
): AppConfig {
  const profiles = [...(config.server_profiles ?? [])];
  const idx = profiles.findIndex(
    (p) => p.id === config.active_server_profile_id,
  );
  if (idx < 0) return config;
  profiles[idx] = { ...profiles[idx], label };
  return { ...config, server_profiles: profiles };
}

export function switchServerProfile(
  config: AppConfig,
  profileId: string,
): AppConfig {
  const pushed = pushFlatToActiveProfile(config);
  const target = findServerProfile(pushed.server_profiles, profileId);
  if (!target || profileId === pushed.active_server_profile_id) return pushed;
  return {
    ...pushed,
    active_server_profile_id: profileId,
    server_url: target.url,
    server_login: target.login,
    server_password: target.password,
  };
}

function nextServerProfileLabel(
  profiles: ServerProfile[],
  base: string,
): string {
  const names = new Set(profiles.map((p) => p.label.trim()));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function createServerProfile(
  config: AppConfig,
  label: string,
): AppConfig {
  const pushed = pushFlatToActiveProfile(config);
  const profiles = [...(pushed.server_profiles ?? [])];
  const id = crypto.randomUUID();
  const nextLabel = nextServerProfileLabel(
    profiles,
    label.trim() || tr("settings.server.smb.newProfileDefault"),
  );
  const fresh = {
    id,
    label: nextLabel,
    url: "",
    login: "",
    password: "",
  };
  profiles.push(fresh);
  return {
    ...pushed,
    server_profiles: profiles,
    active_server_profile_id: id,
    server_url: fresh.url,
    server_login: fresh.login,
    server_password: fresh.password,
  };
}

export function deleteServerProfile(
  config: AppConfig,
  profileId: string,
): AppConfig | null {
  const pushed = pushFlatToActiveProfile(config);
  const profiles = [...(pushed.server_profiles ?? [])];
  if (profiles.length <= 1) return null;
  const idx = profiles.findIndex((p) => p.id === profileId);
  if (idx < 0) return pushed;
  profiles.splice(idx, 1);
  const nextActive =
    pushed.active_server_profile_id === profileId
      ? profiles[0]!.id
      : pushed.active_server_profile_id;
  const target = findServerProfile(profiles, nextActive);
  if (!target) return null;
  return {
    ...pushed,
    server_profiles: profiles,
    active_server_profile_id: nextActive,
    server_url: target.url,
    server_login: target.login,
    server_password: target.password,
  };
}

export function activeServerProfileSummary(config: AppConfig): string {
  const active = getActiveServerProfile(config);
  if (!active) return "";
  const label = displayServerProfileLabel(active);
  const url = active.url.trim();
  if (!url || label === url) return label;
  return `${label} (${url})`;
}

/** Ensure Calden + Gera presets exist (wizard + legacy configs with a single profile). */
export function ensureWizardServerProfiles(config: AppConfig): AppConfig {
  const profiles = [...(config.server_profiles ?? [])];
  let changed = false;

  function upsertPreset(preset: ServerProfile) {
    const byId = profiles.findIndex((p) => p.id === preset.id);
    if (byId >= 0) {
      if (!profiles[byId]!.label.trim()) {
        profiles[byId] = { ...profiles[byId]!, label: preset.label };
        changed = true;
      }
      return;
    }
    const byLabel = profiles.findIndex(
      (p) => p.label.trim() === preset.label,
    );
    if (byLabel >= 0) {
      profiles[byLabel] = { ...profiles[byLabel]!, id: preset.id };
      changed = true;
      return;
    }
    profiles.push(preset);
    changed = true;
  }

  upsertPreset(PRESET_CALDEN_PROFILE);
  upsertPreset(PRESET_GERA_PROFILE);

  profiles.sort((a, b) => {
    const order = (id: string) =>
      id === DEFAULT_SERVER_PROFILE_ID ? 0 : id === GERA_SERVER_PROFILE_ID ? 1 : 2;
    const diff = order(a.id) - order(b.id);
    if (diff !== 0) return diff;
    return displayServerProfileLabel(a).localeCompare(
      displayServerProfileLabel(b),
    );
  });

  if (!changed && profiles.length === (config.server_profiles ?? []).length) {
    return config;
  }

  const activeId = profiles.some(
    (p) => p.id === config.active_server_profile_id,
  )
    ? config.active_server_profile_id
    : DEFAULT_SERVER_PROFILE_ID;

  return switchServerProfile(
    { ...config, server_profiles: profiles, active_server_profile_id: activeId },
    activeId,
  );
}
