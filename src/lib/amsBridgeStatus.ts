import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";

export const AMS_HEALTH_POLL_MS = 45_000;

/** Operator-facing name for the AMS bridge. Keep “AMS” out of everyday UI. */
export const AMS_OPERATOR_TITLE = "Buchungssuche";

export const AMS_UNREACHABLE_LABEL = "Buchungssuche nicht erreichbar";
export const AMS_URL_MISSING_LABEL = "Adresse fehlt";
export const AMS_URL_INVALID_LABEL = "Ungültige Adresse";
export const AMS_TOKEN_MISSING_LABEL = "Zugangscode fehlt";
export const AMS_TOKEN_INVALID_LABEL = "Zugangscode ungültig";

export const AMS_URL_MISSING_HINT =
  "Es ist keine Adresse für die Buchungssuche hinterlegt.";

export const AMS_TOKEN_MISSING_HINT =
  "Bitte den Zugangscode in den Einstellungen eintragen.";

export const AMS_TOKEN_AUTH_HINT = "Bitte den Zugangscode prüfen.";

export const AMS_UNREACHABLE_HINT =
  "Kundendaten bitte von Hand eintragen.";

export const AMS_LOOKUP_ERROR_FALLBACK = "Kunde konnte nicht geladen werden";

export const AMS_HEALTH_OK_MESSAGE = "Buchungssuche verbunden";

export type AmsBridgeErrorKind =
  | "unreachable"
  | "url_missing"
  | "url_invalid"
  | "token_missing"
  | "token_invalid"
  | "error";

export type AmsBridgeErrorDetail = {
  kind: AmsBridgeErrorKind;
  text: string;
  focus: SettingsFocusTarget | null;
};

const LABEL_BY_KIND: Record<AmsBridgeErrorKind, string> = {
  unreachable: AMS_UNREACHABLE_LABEL,
  url_missing: AMS_URL_MISSING_LABEL,
  url_invalid: AMS_URL_INVALID_LABEL,
  token_missing: AMS_TOKEN_MISSING_LABEL,
  token_invalid: AMS_TOKEN_INVALID_LABEL,
  error: AMS_UNREACHABLE_LABEL,
};

export function mapAmsBridgeErrorDetail(message: string): AmsBridgeErrorDetail {
  const raw = message.trim();
  if (!raw) {
    return {
      kind: "unreachable",
      text: AMS_UNREACHABLE_LABEL,
      focus: "ams-bridge-url",
    };
  }

  const lower = raw.toLowerCase();

  if (
    /keine\s+ams-bridge-url|url\s+ist\s+leer|url\s+fehlt/.test(lower)
  ) {
    return {
      kind: "url_missing",
      text: AMS_URL_MISSING_LABEL,
      focus: "ams-bridge-url",
    };
  }
  if (
    /muss\s+mit\s+http|ungültige\s+ams|invalid\s+ams|url\s+muss/.test(lower)
  ) {
    return {
      kind: "url_invalid",
      text: AMS_URL_INVALID_LABEL,
      focus: "ams-bridge-url",
    };
  }
  if (/token\s+fehlt|token\s+missing/.test(lower)) {
    return {
      kind: "token_missing",
      text: AMS_TOKEN_MISSING_LABEL,
      focus: "ams-bridge-token",
    };
  }
  if (/token\s+ungültig|401/.test(lower)) {
    return {
      kind: "token_invalid",
      text: AMS_TOKEN_INVALID_LABEL,
      focus: "ams-bridge-token",
    };
  }
  if (/keinen\s+ams-handoff/.test(lower)) {
    return {
      kind: "error",
      text: "Nur bei Online-Vorgängen, nicht bei Lokal",
      focus: null,
    };
  }
  if (/preflight|customer-lookup/.test(lower) && /not[_ ]?found|nicht gefunden/.test(lower)) {
    return {
      kind: "error",
      text: "Kunde in der Buchung nicht gefunden",
      focus: null,
    };
  }
  if (/meldet\s+online\s*=\s*false|online=false/.test(lower)) {
    return {
      kind: "unreachable",
      text: AMS_UNREACHABLE_LABEL,
      focus: "ams-bridge-url",
    };
  }
  if (
    /nicht\s+erreichbar|timed?\s*out|timeout|connection\s+refused|failed\s+to\s+lookup|dns|os\s+error/.test(
      lower,
    )
  ) {
    return {
      kind: "unreachable",
      text: AMS_UNREACHABLE_LABEL,
      focus: "ams-bridge-url",
    };
  }

  return {
    kind: "error",
    text: LABEL_BY_KIND.error,
    focus: "ams-bridge-url",
  };
}

export function mapAmsBridgeErrorLabel(message: string): string {
  return mapAmsBridgeErrorDetail(message).text;
}

export type AmsBridgeErrorPresentation = {
  message: string;
  focus: SettingsFocusTarget | null;
  primaryAction: DialogPrimaryAction | null;
};

export function presentAmsBridgeError(opts: {
  rawMessage: string;
  omitSettingsAction?: boolean;
}): AmsBridgeErrorPresentation {
  const detail = mapAmsBridgeErrorDetail(opts.rawMessage);
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

  if (detail.kind === "url_missing" || detail.kind === "url_invalid") {
    const hint = detail.kind === "url_missing" ? AMS_URL_MISSING_HINT : null;
    return {
      message: hint ? `${detail.text}\n\n${hint}` : detail.text,
      focus: "ams-bridge-url",
      primaryAction: withAction("Einstellungen öffnen", "ams-bridge-url"),
    };
  }
  if (detail.kind === "token_missing") {
    return {
      message: `${detail.text}\n\n${AMS_TOKEN_MISSING_HINT}`,
      focus: "ams-bridge-token",
      primaryAction: withAction("Zugangscode prüfen", "ams-bridge-token"),
    };
  }
  if (detail.kind === "token_invalid") {
    return {
      message: `${detail.text}\n\n${AMS_TOKEN_AUTH_HINT}`,
      focus: "ams-bridge-token",
      primaryAction: withAction("Zugangscode prüfen", "ams-bridge-token"),
    };
  }

  const message =
    detail.kind === "unreachable"
      ? `${detail.text}\n\n${AMS_UNREACHABLE_HINT}`
      : detail.text;

  return {
    message,
    focus: detail.focus,
    primaryAction: detail.focus
      ? withAction("Einstellungen öffnen", detail.focus)
      : null,
  };
}

export function amsBridgeStatusErrorTooltip(message: string): string {
  return presentAmsBridgeError({
    rawMessage: message,
    omitSettingsAction: true,
  }).message;
}

export function formatAmsConnectedTooltip(): string {
  return `${AMS_OPERATOR_TITLE}: verbunden`;
}

export function formatAmsHealthSuccessMessage(_raw?: string): string {
  return AMS_HEALTH_OK_MESSAGE;
}

export function presentAmsLookupError(raw: string): string {
  const detail = mapAmsBridgeErrorDetail(raw);
  if (
    detail.kind === "token_missing" ||
    detail.kind === "token_invalid" ||
    detail.kind === "url_missing" ||
    detail.kind === "url_invalid"
  ) {
    return detail.text;
  }
  return AMS_LOOKUP_ERROR_FALLBACK;
}

/** Rewrite AMS jargon in errors that reach operators (create, append, …). */
export function presentAmsUserMessage(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (!/\bams\b|ams-bridge|ams[_ -]?preflight|ams[_ -]?lookup|ams[_ -]?manifest/i.test(t)) {
    return t;
  }
  return presentAmsBridgeError({
    rawMessage: t,
    omitSettingsAction: true,
  }).message;
}
