/**
 * Phase 53 — pure booking-lookup gate / path helpers (no i18n / store deps).
 * Spec: `docs/phases/open/53-cloud-lookup-fallback.md` · Master §4 / §6.
 * Mirrored in Rust: `bridge/lookup_map.rs`, `bridge/lookup_router.rs`.
 */

/** Phase 53: usable Cloud JWT (token + base URL + not expired). */
export function isCloudLookupAvailable(
  config: {
    cloud_lookup_access_token?: string | null;
    cloud_lookup_expires_at?: string | null;
    cloud_lookup_cloud_base_url?: string | null;
  } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!config) return false;
  const token = (config.cloud_lookup_access_token ?? "").trim();
  const baseUrl = (config.cloud_lookup_cloud_base_url ?? "").trim();
  const expiresAt = (config.cloud_lookup_expires_at ?? "").trim();
  if (!token || !baseUrl || !expiresAt) return false;
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp > nowMs;
}

/** AMS path live: configured, connected, and lookup capability (empty caps = legacy allow). */
export function isAmsLookupLive(opts: {
  configured: boolean;
  connected: boolean;
  capabilities?: readonly string[] | null;
}): boolean {
  if (!opts.configured || !opts.connected) return false;
  const caps = opts.capabilities ?? [];
  if (caps.length === 0) return true;
  return caps.includes("lookup");
}

export type BookingLookupPath = "ams" | "cloud" | "offline";

/** Operator path for booking lookup (AMS · Cloud · Offline). */
export function bookingLookupPath(opts: {
  amsLive: boolean;
  cloudLookupAvailable: boolean;
}): BookingLookupPath {
  if (opts.amsLive) return "ams";
  if (opts.cloudLookupAvailable) return "cloud";
  return "offline";
}

/**
 * Booking ID-lookup gate (Phase 53 / T3): AMS live **or** usable Cloud JWT.
 * Offline → silent (no lookup attempts).
 */
export function canRunAmsIdLookup(opts: {
  configured: boolean;
  connected: boolean;
  capabilities?: readonly string[] | null;
  cloudLookupAvailable?: boolean;
}): boolean {
  const amsLive = isAmsLookupLive(opts);
  return amsLive || Boolean(opts.cloudLookupAvailable);
}

export function isLookupUnreachable(message: string): boolean {
  return message.includes("nicht erreichbar");
}

/** Cloud JWT rejected (401 / revoke) — backend already cleared; sync UI gate. */
export function isCloudLookupTokenInvalid(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("token_invalid") ||
    m.includes("token ungültig") ||
    (m.includes("cloud-lookup") && m.includes("401"))
  );
}

/** Clear Cloud JWT fields in the in-memory config (after backend revoke/401). */
export function clearCloudLookupConfigLocal(updateLocal: (patch: {
  cloud_lookup_access_token: string;
  cloud_lookup_expires_at: string;
  cloud_lookup_cloud_base_url: string;
  cloud_lookup_ams_server_instance_id: string;
}) => void): void {
  updateLocal({
    cloud_lookup_access_token: "",
    cloud_lookup_expires_at: "",
    cloud_lookup_cloud_base_url: "",
    cloud_lookup_ams_server_instance_id: "",
  });
}

/** Sync in-memory Cloud JWT fields from a fresh config snapshot. */
export function syncCloudLookupConfigLocal(
  cfg: {
    cloud_lookup_access_token?: string | null;
    cloud_lookup_expires_at?: string | null;
    cloud_lookup_cloud_base_url?: string | null;
    cloud_lookup_ams_server_instance_id?: string | null;
  },
  updateLocal: (patch: {
    cloud_lookup_access_token: string;
    cloud_lookup_expires_at: string;
    cloud_lookup_cloud_base_url: string;
    cloud_lookup_ams_server_instance_id: string;
  }) => void,
): void {
  updateLocal({
    cloud_lookup_access_token: cfg.cloud_lookup_access_token ?? "",
    cloud_lookup_expires_at: cfg.cloud_lookup_expires_at ?? "",
    cloud_lookup_cloud_base_url: cfg.cloud_lookup_cloud_base_url ?? "",
    cloud_lookup_ams_server_instance_id:
      cfg.cloud_lookup_ams_server_instance_id ?? "",
  });
}
