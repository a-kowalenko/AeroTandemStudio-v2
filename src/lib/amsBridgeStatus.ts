import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";
import { tr } from "@/i18n";

export const AMS_HEALTH_POLL_MS = 45_000;

/** Operator-facing name for the AMS bridge. Keep “AMS” out of everyday UI. */
export function amsOperatorTitle(): string {
  return tr("settings.server.ams.operatorTitle");
}

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
  unreachable: "ams.status.unreachableLabel",
  url_missing: "ams.status.urlMissingLabel",
  url_invalid: "ams.status.urlInvalidLabel",
  token_missing: "ams.status.tokenMissingLabel",
  token_invalid: "ams.status.tokenInvalidLabel",
  error: "ams.status.unreachableLabel",
};

function amsLabel(key: string): string {
  return tr(key);
}

export function mapAmsBridgeErrorDetail(message: string): AmsBridgeErrorDetail {
  const raw = message.trim();
  if (!raw) {
    return {
      kind: "unreachable",
      text: amsLabel(LABEL_BY_KIND.unreachable),
      focus: "ams-bridge-url",
    };
  }

  const lower = raw.toLowerCase();

  if (
    /keine\s+ams-bridge-url|url\s+ist\s+leer|url\s+fehlt/.test(lower)
  ) {
    return {
      kind: "url_missing",
      text: amsLabel(LABEL_BY_KIND.url_missing),
      focus: "ams-bridge-url",
    };
  }
  if (
    /muss\s+mit\s+http|ungültige\s+ams|invalid\s+ams|url\s+muss/.test(lower)
  ) {
    return {
      kind: "url_invalid",
      text: amsLabel(LABEL_BY_KIND.url_invalid),
      focus: "ams-bridge-url",
    };
  }
  if (/token\s+fehlt|token\s+missing/.test(lower)) {
    return {
      kind: "token_missing",
      text: amsLabel(LABEL_BY_KIND.token_missing),
      focus: "ams-bridge-token",
    };
  }
  if (/token\s+ungültig|401/.test(lower)) {
    return {
      kind: "token_invalid",
      text: amsLabel(LABEL_BY_KIND.token_invalid),
      focus: "ams-bridge-token",
    };
  }
  if (/keinen\s+ams-handoff/.test(lower)) {
    return {
      kind: "error",
      text: tr("ams.status.onlineOnly"),
      focus: null,
    };
  }
  if (/preflight|customer-lookup/.test(lower) && /not[_ ]?found|nicht gefunden/.test(lower)) {
    return {
      kind: "error",
      text: tr("ams.status.customerNotFound"),
      focus: null,
    };
  }
  if (/meldet\s+online\s*=\s*false|online=false/.test(lower)) {
    return {
      kind: "unreachable",
      text: amsLabel(LABEL_BY_KIND.unreachable),
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
      text: amsLabel(LABEL_BY_KIND.unreachable),
      focus: "ams-bridge-url",
    };
  }

  return {
    kind: "error",
    text: amsLabel(LABEL_BY_KIND.error),
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
    const hint = detail.kind === "url_missing" ? tr("ams.status.urlMissingHint") : null;
    return {
      message: hint ? `${detail.text}\n\n${hint}` : detail.text,
      focus: "ams-bridge-url",
      primaryAction: withAction(tr("ams.actions.openSettings"), "ams-bridge-url"),
    };
  }
  if (detail.kind === "token_missing") {
    return {
      message: `${detail.text}\n\n${tr("ams.status.tokenMissingHint")}`,
      focus: "ams-bridge-token",
      primaryAction: withAction(tr("ams.actions.checkToken"), "ams-bridge-token"),
    };
  }
  if (detail.kind === "token_invalid") {
    return {
      message: `${detail.text}\n\n${tr("ams.status.tokenAuthHint")}`,
      focus: "ams-bridge-token",
      primaryAction: withAction(tr("ams.actions.checkToken"), "ams-bridge-token"),
    };
  }

  const message =
    detail.kind === "unreachable"
      ? `${detail.text}\n\n${tr("ams.status.unreachableHint")}`
      : detail.text;

  return {
    message,
    focus: detail.focus,
    primaryAction: detail.focus
      ? withAction(tr("ams.actions.openSettings"), detail.focus)
      : null,
  };
}

export function amsBridgeStatusErrorTooltip(message: string): string {
  return presentAmsBridgeError({
    rawMessage: message,
    omitSettingsAction: true,
  }).message;
}

export function formatAmsConnectedTooltip(displayName?: string): string {
  const name = displayName?.trim();
  if (name) {
    return tr("ams.status.connectedTooltipNamed", {
      title: amsOperatorTitle(),
      name,
    });
  }
  return tr("ams.status.connectedTooltip", { title: amsOperatorTitle() });
}

/** Instance label in connection dialogs (AMS display name or operator title). */
export function amsConnectionLabel(displayName?: string | null): string {
  const name = displayName?.trim();
  return name || amsOperatorTitle();
}

export function formatAmsConnectionDialogTitle(displayName?: string | null): string {
  const name = displayName?.trim();
  if (name) {
    return tr("header.connection.titleAmsOkNamed", { name });
  }
  return tr("header.connection.titleAmsOk");
}

export function formatAmsHealthSuccessMessage(displayName?: string | null): string {
  const name = displayName?.trim();
  if (name) {
    return tr("ams.status.healthOkNamed", { name });
  }
  return tr("ams.status.healthOk");
}

export function formatAmsFoundSuccessViaServerPassword(
  displayName?: string | null,
): string {
  const name = displayName?.trim();
  if (name) {
    return tr("settings.server.ams.foundSuccessViaServerPasswordNamed", { name });
  }
  return tr("settings.server.ams.foundSuccessViaServerPassword");
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
  return tr("ams.status.lookupErrorFallback");
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
