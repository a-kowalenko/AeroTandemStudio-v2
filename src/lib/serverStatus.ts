import { tr } from "@/i18n";
import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";

export function serverConnectionStatusLabel(
  phase: ServerPhase,
  message = "",
): string {
  switch (phase) {
    case "connected":
      return tr("errors.server.connected");
    case "checking":
      return tr("errors.server.checking");
    case "uploading":
      return tr("errors.server.uploading");
    case "idle":
      return tr("errors.server.notChecked");
    case "error":
      return mapServerErrorLabel(message);
    default:
      return tr("errors.server.notChecked");
  }
}

export function mapServerErrorLabel(message: string): string {
  const detail = mapServerErrorDetail(message);
  if (detail.kind === "unreachable") return tr("errors.server.notConnected");
  return detail.text;
}

export function mapServerErrorDetail(message: string): {
  kind: "unreachable" | "error";
  text: string;
} {
  const raw = message.trim();
  if (!raw) {
    return { kind: "unreachable", text: tr("errors.server.notConnected") };
  }

  const lower = raw.toLowerCase();

  if (
    /ungültige\s+server-url|invalid\s+server|url\s+fehlt|keine\s+server/.test(
      lower,
    )
  ) {
    return { kind: "error", text: tr("errors.server.invalidUrl") };
  }
  if (/lokaler\s+pfad\s+nicht\s+gefunden|path\s+not\s+found/.test(lower)) {
    return { kind: "error", text: tr("errors.server.pathNotFound") };
  }
  if (
    /ungültiger\s+benutzername|passwort|logon|access_denied.*session|login\s+fehl/.test(
      lower,
    )
  ) {
    return { kind: "error", text: tr("errors.server.loginFailed") };
  }
  if (/kein\s+zugriff\s+auf\s+freigabe/.test(lower)) {
    return { kind: "error", text: tr("errors.server.noShareAccess") };
  }
  if (/listing\s+fehlgeschlagen/.test(lower)) {
    return {
      kind: "error",
      text: tr("errors.server.listingFailed"),
    };
  }
  if (
    /bad_network_name|object_name_not_found|share\s+nicht|server\s+oder\s+freigabe|freigabe\s+'/.test(
      lower,
    )
  ) {
    return { kind: "error", text: tr("errors.server.shareNotFound") };
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
        text:
          short.length > 60 ? tr("errors.server.notConnected") : short,
      };
    }
    return { kind: "unreachable", text: tr("errors.server.notConnected") };
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
    return { kind: "unreachable", text: tr("errors.server.notConnected") };
  }

  if (short.length > 52) {
    short = `${short.slice(0, 49)}…`;
  }
  return { kind: "error", text: short || tr("errors.server.notConnected") };
}

export function serverCredentialsMissing(
  login: string,
  password: string,
): boolean {
  return !login.trim() && !password.trim();
}

export function serverCredentialsSoftHint(): string {
  return tr("errors.server.credentialsSoftHint");
}

export function serverAuthHint(): string {
  return tr("errors.server.authHint");
}

export function serverUrlMissingHint(): string {
  return tr("errors.server.urlMissingHint");
}

export function serverGuestHint(): string {
  return tr("errors.server.guestHint");
}

export type ServerErrorPresentation = {
  message: string;
  focus: SettingsFocusTarget | null;
  primaryAction: DialogPrimaryAction | null;
};

export function presentServerConnectionError(opts: {
  rawMessage: string;
  serverUrl: string;
  login: string;
  password: string;
  omitSettingsAction?: boolean;
}): ServerErrorPresentation {
  const detail = mapServerErrorDetail(opts.rawMessage);
  const urlMissing = !opts.serverUrl.trim();
  const credsMissing = serverCredentialsMissing(opts.login, opts.password);
  const loginFailed = tr("errors.server.loginFailed");
  const invalidUrl = tr("errors.server.invalidUrl");
  const isAuthFailure = detail.text === loginFailed;
  const isInvalidUrl = detail.text === invalidUrl;

  const withAction = (
    label: string,
    focus: SettingsFocusTarget,
  ): DialogPrimaryAction | null =>
    opts.omitSettingsAction
      ? null
      : {
          label,
          openSettings: { tab: "server", focus },
        };

  if (urlMissing || isInvalidUrl) {
    const hint = urlMissing ? serverUrlMissingHint() : null;
    return {
      message: hint ? `${detail.text}\n\n${hint}` : detail.text,
      focus: "server-url",
      primaryAction: withAction(tr("errors.server.openUrl"), "server-url"),
    };
  }

  if (isAuthFailure) {
    return {
      message: `${detail.text}\n\n${serverAuthHint()}`,
      focus: "server-credentials",
      primaryAction: withAction(
        tr("errors.server.checkCredentials"),
        "server-credentials",
      ),
    };
  }

  if (detail.kind === "unreachable" && credsMissing) {
    return {
      message: `${detail.text}\n\n${serverCredentialsSoftHint()}`,
      focus: "server-credentials",
      primaryAction: withAction(
        tr("errors.server.openCredentials"),
        "server-credentials",
      ),
    };
  }

  return {
    message: detail.text,
    focus: null,
    primaryAction: null,
  };
}

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
