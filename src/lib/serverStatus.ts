import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";

/** Compact label next to „Verbindung testen“ / status chip. */
export function serverConnectionStatusLabel(
  phase: ServerPhase,
  message = "",
): string {
  switch (phase) {
    case "connected":
      return "✓ Verbunden";
    case "checking":
      return "Prüfe…";
    case "uploading":
      return "Upload…";
    case "idle":
      return "Nicht geprüft";
    case "error":
      return mapServerErrorLabel(message);
    default:
      return "Nicht geprüft";
  }
}

/**
 * Compact status line: reachability → „Nicht verbunden“;
 * concrete faults stay specific (login, share, URL, …).
 */
export function mapServerErrorLabel(message: string): string {
  const detail = mapServerErrorDetail(message);
  if (detail.kind === "unreachable") return "Nicht verbunden";
  return detail.text;
}

/** Short text for dialogs/toasts after an explicit connection test. */
export function mapServerErrorDetail(message: string): {
  kind: "unreachable" | "error";
  text: string;
} {
  const raw = message.trim();
  if (!raw) {
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  const lower = raw.toLowerCase();

  if (
    /ungültige\s+server-url|invalid\s+server|url\s+fehlt|keine\s+server/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Ungültige Server-URL" };
  }
  if (/lokaler\s+pfad\s+nicht\s+gefunden|path\s+not\s+found/.test(lower)) {
    return { kind: "error", text: "Pfad nicht gefunden" };
  }
  if (
    /ungültiger\s+benutzername|passwort|logon|access_denied.*session|login\s+fehl/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Login fehlgeschlagen" };
  }
  if (/kein\s+zugriff\s+auf\s+freigabe/.test(lower)) {
    return { kind: "error", text: "Kein Zugriff auf Freigabe" };
  }
  if (/listing\s+fehlgeschlagen/.test(lower)) {
    return {
      kind: "error",
      text: "Share erreichbar, Listing fehlgeschlagen",
    };
  }
  if (
    /bad_network_name|object_name_not_found|share\s+nicht|server\s+oder\s+freigabe|freigabe\s+'/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Server/Freigabe nicht gefunden" };
  }

  if (
    /nicht\s+erreichbar|timed?\s*out|timeout|connection\s+refused|actively\s+refused|no\s+route|network\s+is\s+unreachable|host\s+unreachable|failed\s+to\s+lookup|name\s+or\s+service|no\s+such\s+host|dns\s+error|os\s+error\s+10060|os\s+error\s+10061|os\s+error\s+110|os\s+error\s+111|smb-verbindung\s+fehlgeschlagen/.test(
      lower,
    )
  ) {
    if (/server nicht erreichbar/i.test(raw)) {
      const short = raw.replace(/\.$/, "");
      return {
        kind: "unreachable",
        text: short.length > 60 ? "Nicht verbunden" : short,
      };
    }
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  let short = raw
    .replace(/^SMB-Verbindung fehlgeschlagen:\s*/i, "")
    .replace(/^Verbindung fehlgeschlagen:\s*/i, "")
    .trim();

  if (
    /error\s+sending|reqwest|dns\s+error|os\s+error|errno|0x[0-9a-f]+/i.test(
      short,
    )
  ) {
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  if (short.length > 52) {
    short = `${short.slice(0, 49)}…`;
  }
  return { kind: "error", text: short || "Nicht verbunden" };
}

/** Neither login nor password configured (empty login → Guest on the backend). */
export function serverCredentialsMissing(
  login: string,
  password: string,
): boolean {
  return !login.trim() && !password.trim();
}

export const SERVER_CREDENTIALS_SOFT_HINT =
  "Zugangsdaten sind nicht hinterlegt. Das kann (muss aber nicht) der Grund sein.";

export const SERVER_AUTH_HINT =
  "Bitte Benutzername und Passwort prüfen.";

export const SERVER_URL_MISSING_HINT =
  "Es ist keine Server-URL hinterlegt.";

export const SERVER_GUEST_HINT =
  "Ohne Login wird als Guest verbunden.";

export type ServerErrorPresentation = {
  /** Dialog / toast body (may include soft hint). */
  message: string;
  /** Suggested settings deep-link target. */
  focus: SettingsFocusTarget | null;
  /** CTA for ErrorDialog; null when omitSettingsAction or no guidance. */
  primaryAction: DialogPrimaryAction | null;
};

/**
 * Build user-facing server error copy + optional Settings deep-link.
 * Soft-hints stay speculative; transport/auth diagnosis stays in the first line.
 */
export function presentServerConnectionError(opts: {
  rawMessage: string;
  serverUrl: string;
  login: string;
  password: string;
  /** Already in Settings / Wizard — no „open settings“ button. */
  omitSettingsAction?: boolean;
}): ServerErrorPresentation {
  const detail = mapServerErrorDetail(opts.rawMessage);
  const urlMissing = !opts.serverUrl.trim();
  const credsMissing = serverCredentialsMissing(opts.login, opts.password);
  const isAuthFailure = detail.text === "Login fehlgeschlagen";
  const isInvalidUrl = detail.text === "Ungültige Server-URL";

  const withAction = (
    label: string,
    focus: SettingsFocusTarget,
  ): DialogPrimaryAction | null =>
    opts.omitSettingsAction
      ? null
      : {
          label,
          openSettings: { tab: "allgemein", focus },
        };

  // URL missing or invalid → point at the URL field first.
  if (urlMissing || isInvalidUrl) {
    const hint = urlMissing ? SERVER_URL_MISSING_HINT : null;
    return {
      message: hint ? `${detail.text}\n\n${hint}` : detail.text,
      focus: "server-url",
      primaryAction: withAction("Server-URL öffnen", "server-url"),
    };
  }

  if (isAuthFailure) {
    return {
      message: `${detail.text}\n\n${SERVER_AUTH_HINT}`,
      focus: "server-credentials",
      primaryAction: withAction("Zugangsdaten prüfen", "server-credentials"),
    };
  }

  if (detail.kind === "unreachable" && credsMissing) {
    return {
      message: `${detail.text}\n\n${SERVER_CREDENTIALS_SOFT_HINT}`,
      focus: "server-credentials",
      primaryAction: withAction("Zugangsdaten öffnen", "server-credentials"),
    };
  }

  return {
    message: detail.text,
    focus: null,
    primaryAction: null,
  };
}

/** Tooltip / title soft-hint when the status chip is in error. */
export function serverStatusErrorTooltip(
  message: string,
  login: string,
  password: string,
  serverUrl = "",
): string {
  const presented = presentServerConnectionError({
    rawMessage: message,
    serverUrl,
    login,
    password,
    omitSettingsAction: true,
  });
  return presented.message;
}
