import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";

export const AMS_HEALTH_POLL_MS = 45_000;

export const AMS_URL_MISSING_HINT =
  "Es ist keine AMS-Bridge-URL hinterlegt.";

export const AMS_TOKEN_MISSING_HINT =
  "Bitte das Bridge-Token in den Einstellungen eintragen.";

export const AMS_TOKEN_AUTH_HINT =
  "Bitte das Bridge-Token prüfen.";

export type AmsBridgeErrorDetail = {
  kind: "unreachable" | "error";
  text: string;
  focus: SettingsFocusTarget | null;
};

export function mapAmsBridgeErrorDetail(message: string): AmsBridgeErrorDetail {
  const raw = message.trim();
  if (!raw) {
    return {
      kind: "unreachable",
      text: "AMS nicht verbunden",
      focus: "ams-bridge-url",
    };
  }

  const lower = raw.toLowerCase();

  if (
    /keine\s+ams-bridge-url|url\s+ist\s+leer|url\s+fehlt/.test(lower)
  ) {
    return {
      kind: "error",
      text: "AMS-URL fehlt",
      focus: "ams-bridge-url",
    };
  }
  if (
    /muss\s+mit\s+http|ungültige\s+ams|invalid\s+ams|url\s+muss/.test(lower)
  ) {
    return {
      kind: "error",
      text: "Ungültige AMS-URL",
      focus: "ams-bridge-url",
    };
  }
  if (/token\s+fehlt|token\s+missing/.test(lower)) {
    return {
      kind: "error",
      text: "AMS-Token fehlt",
      focus: "ams-bridge-token",
    };
  }
  if (/token\s+ungültig|401/.test(lower)) {
    return {
      kind: "error",
      text: "AMS-Token ungültig",
      focus: "ams-bridge-token",
    };
  }
  if (/meldet\s+online\s*=\s*false|online=false/.test(lower)) {
    return {
      kind: "unreachable",
      text: "AMS nicht verbunden",
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
      text: "AMS nicht verbunden",
      focus: "ams-bridge-url",
    };
  }

  let short = raw
    .replace(/^AMS-Bridge\s+/i, "")
    .replace(/^health\s+/i, "")
    .trim();
  if (short.length > 52) short = `${short.slice(0, 49)}…`;
  return {
    kind: "error",
    text: short || "AMS nicht verbunden",
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

  if (detail.text === "AMS-URL fehlt" || detail.text === "Ungültige AMS-URL") {
    const hint =
      detail.text === "AMS-URL fehlt" ? AMS_URL_MISSING_HINT : null;
    return {
      message: hint ? `${detail.text}\n\n${hint}` : detail.text,
      focus: "ams-bridge-url",
      primaryAction: withAction("AMS-URL öffnen", "ams-bridge-url"),
    };
  }
  if (detail.text === "AMS-Token fehlt") {
    return {
      message: `${detail.text}\n\n${AMS_TOKEN_MISSING_HINT}`,
      focus: "ams-bridge-token",
      primaryAction: withAction("Token öffnen", "ams-bridge-token"),
    };
  }
  if (detail.text === "AMS-Token ungültig") {
    return {
      message: `${detail.text}\n\n${AMS_TOKEN_AUTH_HINT}`,
      focus: "ams-bridge-token",
      primaryAction: withAction("Token prüfen", "ams-bridge-token"),
    };
  }

  return {
    message: detail.text,
    focus: detail.focus,
    primaryAction: detail.focus
      ? withAction("AMS-Bridge öffnen", detail.focus)
      : null,
  };
}

export function amsBridgeStatusErrorTooltip(message: string): string {
  return presentAmsBridgeError({
    rawMessage: message,
    omitSettingsAction: true,
  }).message;
}

export function formatAmsConnectedTooltip(
  version: string,
  capabilities: string[],
): string {
  const caps = capabilities.filter(Boolean).join(", ");
  const ver = version.trim();
  if (ver && caps) return `AMS: online v${ver} · ${caps}`;
  if (ver) return `AMS: online v${ver}`;
  if (caps) return `AMS: verbunden · ${caps}`;
  return "AMS: verbunden";
}
