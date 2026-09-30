/** Quiet SMB poll base interval matches AMS (`AMS_HEALTH_POLL_MS`). */
export const SMB_LOUD_AFTER_HIDDEN_MS = 10 * 60 * 1000;

/** OPT-23E: stagger fleet wake after a NAS restart (±10 %). */
export const SMB_POLL_JITTER_RATIO = 0.1;

export type SmbHealthEvent = {
  ok: boolean;
  host: string;
  message: string;
};

/** `baseMs` scaled into `[1-ratio, 1+ratio]`. `random01` is in `[0, 1]`. */
export function jitteredPollDelay(
  baseMs: number,
  random01: number = Math.random(),
): number {
  const clamped = Math.min(1, Math.max(0, random01));
  const factor =
    1 -
    SMB_POLL_JITTER_RATIO +
    clamped * (SMB_POLL_JITTER_RATIO * 2);
  return Math.max(1, Math.round(baseMs * factor));
}

/** Host from `smb://`, UNC, or `//`. Local paths have no host. */
export function smbHostFromServerUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  if (/^smb:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").trim().toLowerCase();
      return host || null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    const body = raw.replace(/^\\\\|^\/\//, "");
    let host = body.split(/[\\/]/)[0]?.trim() ?? "";
    if (!host) return null;
    const at = host.lastIndexOf("@");
    if (at >= 0) host = host.slice(at + 1);
    if (host.startsWith("[")) {
      const end = host.indexOf("]");
      host = end > 0 ? host.slice(1, end) : host.replace(/^\[|\]$/g, "");
    } else {
      const colon = host.lastIndexOf(":");
      if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
        host = host.slice(0, colon);
      }
    }
    host = host.trim().toLowerCase();
    return host || null;
  }
  return null;
}

export function smbHostsMatch(
  eventHost: string,
  configuredHost: string | null,
): boolean {
  if (!configuredHost) return false;
  const event = eventHost.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return event.length > 0 && event === configuredHost;
}
