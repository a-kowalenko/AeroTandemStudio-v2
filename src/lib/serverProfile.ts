import type { AppConfig } from "@/lib/tauri";

export const DEFAULT_SERVER_PROFILE_ID = "default";
export const DEFAULT_SERVER_URL = "smb://169.254.169.254/aktuell";

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
    label.trim() || "Neu",
  );
  const fresh = {
    id,
    label: nextLabel,
    url: DEFAULT_SERVER_URL,
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
