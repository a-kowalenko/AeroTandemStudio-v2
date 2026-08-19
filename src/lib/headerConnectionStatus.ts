import type { AmsBridgePhase } from "@/store/amsBridgeStore";
import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";
import type { AmsBridgeHealthResult, ConnectionTestResult } from "@/lib/tauri";
import { tr } from "@/i18n";
import {
  AMS_OPERATOR_TITLE,
  amsBridgeStatusErrorTooltip,
  formatAmsConnectedTooltip,
  formatAmsHealthSuccessMessage,
  presentAmsBridgeError,
} from "./amsBridgeStatus";
import {
  mapServerErrorLabel,
  presentServerConnectionError,
  serverStatusErrorTooltip,
} from "./serverStatus";

export type ConnectionDot = "ok" | "error" | "checking" | "idle";

export type HeaderConnectionView = {
  visible: boolean;
  label: string;
  toneClass: string;
  smbDot: ConnectionDot;
  amsDot: ConnectionDot | null;
  title: string;
  canRetry: boolean;
  contextMenuFocus: SettingsFocusTarget | null;
};

function smbDot(phase: ServerPhase, connected: boolean): ConnectionDot {
  if (phase === "checking") return "checking";
  if (phase === "uploading") return connected ? "ok" : "idle";
  if (phase === "connected" || connected) return "ok";
  if (phase === "error") return "error";
  return "idle";
}

function amsDot(phase: AmsBridgePhase, connected: boolean): ConnectionDot {
  if (phase === "checking") return "checking";
  if (phase === "connected" || connected) return "ok";
  if (phase === "error") return "error";
  return "idle";
}

function smbTooltipLine(
  phase: ServerPhase,
  connected: boolean,
  message: string,
  login: string,
  password: string,
  serverUrl: string,
): string {
  if (phase === "checking") return tr("header.connection.serverChecking");
  if (phase === "uploading") return tr("header.connection.serverUploading");
  if (phase === "error") {
    const detail = serverStatusErrorTooltip(message, login, password, serverUrl);
    return detail.includes("\n")
      ? tr("header.connection.serverWithDetailMultiline", { detail })
      : tr("header.connection.serverWithDetail", { detail });
  }
  if (phase === "connected" || connected) return tr("header.connection.serverConnected");
  if (!serverUrl.trim()) return tr("header.connection.serverNotConfigured");
  return tr("header.connection.serverNotChecked");
}

function amsTooltipLine(
  phase: AmsBridgePhase,
  connected: boolean,
  message: string,
): string {
  if (phase === "checking") {
    return tr("header.connection.amsChecking", { title: AMS_OPERATOR_TITLE });
  }
  if (phase === "error") {
    return amsBridgeStatusErrorTooltip(message);
  }
  if (phase === "connected" || connected) {
    return formatAmsConnectedTooltip();
  }
  return tr("header.connection.amsNotChecked", { title: AMS_OPERATOR_TITLE });
}

export function presentHeaderConnection(input: {
  smbPhase: ServerPhase;
  smbConnected: boolean;
  smbMessage: string;
  uploadPercent: number | null;
  uploadFilename: string | null;
  amsConfigured: boolean;
  amsPhase: AmsBridgePhase;
  amsConnected: boolean;
  amsMessage: string;
  serverUrl: string;
  login: string;
  password: string;
}): HeaderConnectionView {
  const smbVisible = !(input.smbPhase === "idle" && !input.smbConnected);
  const amsVisible = input.amsConfigured && input.amsPhase !== "idle";
  const visible = smbVisible || amsVisible;

  const smbChecking = input.smbPhase === "checking";
  const amsChecking = input.amsConfigured && input.amsPhase === "checking";
  const smbOk = input.smbConnected || input.smbPhase === "connected";
  const amsOk = input.amsConnected || input.amsPhase === "connected";
  const smbError = input.smbPhase === "error";
  const amsError = input.amsConfigured && input.amsPhase === "error";

  let label = tr("app.server.title");
  let toneClass = "text-muted";

  if (input.smbPhase === "uploading") {
    const pct = input.uploadPercent ?? 0;
    label = tr("app.upload.percent", { percent: pct.toFixed(0) });
    toneClass = "text-primary";
  } else if (smbChecking) {
    label = tr("common.actions.checking");
    toneClass = "text-warning";
  } else if (smbError) {
    label = mapServerErrorLabel(input.smbMessage);
    toneClass = "text-destructive";
  } else if (smbOk) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  } else if (amsOk && !amsError) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  }

  const canRetry =
    visible &&
    input.smbPhase !== "uploading" &&
    !smbChecking &&
    !(input.smbPhase === "idle" && amsChecking);

  let contextMenuFocus: SettingsFocusTarget | null = null;
  if (smbError) {
    contextMenuFocus =
      presentServerConnectionError({
        rawMessage: input.smbMessage,
        serverUrl: input.serverUrl,
        login: input.login,
        password: input.password,
        omitSettingsAction: true,
      }).focus ?? "server-credentials";
  } else if (amsError) {
    contextMenuFocus =
      presentAmsBridgeError({
        rawMessage: input.amsMessage,
        omitSettingsAction: true,
      }).focus ?? "ams-bridge-url";
  }

  const lines = [
    smbTooltipLine(
      input.smbPhase,
      input.smbConnected,
      input.smbMessage,
      input.login,
      input.password,
      input.serverUrl,
    ),
  ];
  if (input.amsConfigured) {
    lines.push(
      amsTooltipLine(
        input.amsPhase,
        input.amsConnected,
        input.amsMessage,
      ),
    );
  }
  if (input.smbPhase === "uploading" && input.uploadFilename) {
    lines.push(input.uploadFilename);
  }
  if (canRetry) {
    lines.push(
      contextMenuFocus
        ? tr("header.connection.retryOrSettings")
        : tr("header.connection.retry"),
    );
  }

  return {
    visible,
    label,
    toneClass,
    smbDot: smbDot(input.smbPhase, input.smbConnected),
    amsDot: input.amsConfigured
      ? amsDot(input.amsPhase, input.amsConnected)
      : null,
    title: lines.join("\n"),
    canRetry,
    contextMenuFocus,
  };
}

export type HeaderRetryOutcome = {
  kind: "success" | "error";
  title: string;
  message: string;
  primaryAction: DialogPrimaryAction | null;
};

export function presentHeaderRetryOutcome(opts: {
  smb: ConnectionTestResult | null;
  ams: AmsBridgeHealthResult | null;
  serverUrl: string;
  login: string;
  password: string;
}): HeaderRetryOutcome | null {
  const { smb, ams } = opts;
  if (!smb && !ams) return null;

  const smbOk = !smb || smb.ok;
  const amsOk = !ams || ams.ok;
  const smbPresented = smb && !smb.ok
    ? presentServerConnectionError({
        rawMessage: smb.message,
        serverUrl: opts.serverUrl,
        login: opts.login,
        password: opts.password,
      })
    : null;
  const amsPresented = ams && !ams.ok
    ? presentAmsBridgeError({ rawMessage: ams.message })
    : null;

  const parts: string[] = [];
  if (smb) parts.push(smb.ok ? smb.message : smbPresented?.message ?? smb.message);
  if (ams) {
    parts.push(
      ams.ok
        ? formatAmsHealthSuccessMessage(ams.message)
        : amsPresented?.message ?? ams.message,
    );
  }
  const message = parts.join("\n\n");

  if (smbOk && amsOk) {
    const title = smb && ams
      ? tr("header.connection.connectionTitle")
      : smb
        ? tr("app.server.title")
        : AMS_OPERATOR_TITLE;
    return { kind: "success", title, message, primaryAction: null };
  }
  if (!smbOk && !amsOk) {
    return {
      kind: "error",
      title: tr("header.connection.connectionTitle"),
      message,
      primaryAction: smbPresented?.primaryAction ?? amsPresented?.primaryAction ?? null,
    };
  }
  if (!smbOk) {
    return {
      kind: "error",
      title: tr("app.server.title"),
      message: smbPresented?.message ?? smb?.message ?? message,
      primaryAction: smbPresented?.primaryAction ?? null,
    };
  }
  return {
    kind: "error",
    title: AMS_OPERATOR_TITLE,
    message: amsPresented?.message ?? ams?.message ?? message,
    primaryAction: amsPresented?.primaryAction ?? null,
  };
}
