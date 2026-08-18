import type { AmsBridgePhase } from "@/store/amsBridgeStore";
import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";
import type { AmsBridgeHealthResult, ConnectionTestResult } from "@/lib/tauri";
import {
  amsBridgeStatusErrorTooltip,
  formatAmsConnectedTooltip,
  mapAmsBridgeErrorLabel,
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
  if (phase === "checking") return "Server: Prüfung…";
  if (phase === "uploading") return "Server: Upload läuft";
  if (phase === "error") {
    const detail = serverStatusErrorTooltip(message, login, password, serverUrl);
    return detail.includes("\n") ? `Server:\n${detail}` : `Server: ${detail}`;
  }
  if (phase === "connected" || connected) return "Server: verbunden";
  if (!serverUrl.trim()) return "Server: nicht konfiguriert";
  return "Server: nicht geprüft";
}

function amsTooltipLine(
  phase: AmsBridgePhase,
  connected: boolean,
  message: string,
  version: string,
  capabilities: string[],
): string {
  if (phase === "checking") return "AMS: Prüfung…";
  if (phase === "error") {
    const detail = amsBridgeStatusErrorTooltip(message);
    return detail.includes("\n") ? `AMS:\n${detail}` : `AMS: ${detail}`;
  }
  if (phase === "connected" || connected) {
    return formatAmsConnectedTooltip(version, capabilities);
  }
  return "AMS: nicht geprüft";
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
  amsVersion: string;
  amsCapabilities: string[];
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

  let label = "Server";
  let toneClass = "text-muted";

  if (input.smbPhase === "uploading") {
    const pct = input.uploadPercent ?? 0;
    label = `Upload ${pct.toFixed(0)}%`;
    toneClass = "text-primary";
  } else if (smbChecking) {
    label = "Prüfe…";
    toneClass = "text-warning";
  } else if (smbError) {
    label = mapServerErrorLabel(input.smbMessage);
    toneClass = "text-destructive";
  } else if (amsError) {
    label = mapAmsBridgeErrorLabel(input.amsMessage);
    toneClass = "text-warning";
  } else if (
    amsChecking &&
    !smbOk &&
    input.smbPhase === "idle"
  ) {
    label = "Prüfe…";
    toneClass = "text-warning";
  } else if (smbOk || amsOk) {
    label = "Verbunden";
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
        input.amsVersion,
        input.amsCapabilities,
      ),
    );
  }
  if (input.smbPhase === "uploading" && input.uploadFilename) {
    lines.push(input.uploadFilename);
  }
  if (canRetry) {
    lines.push(
      contextMenuFocus
        ? "Klicken: erneut prüfen · Rechtsklick: Einstellungen"
        : "Klicken zum erneuten Prüfen",
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
  if (ams) parts.push(ams.ok ? ams.message : amsPresented?.message ?? ams.message);
  const message = parts.join("\n\n");

  if (smbOk && amsOk) {
    const title = smb && ams ? "Verbindung" : smb ? "Server" : "AMS-Bridge";
    return { kind: "success", title, message, primaryAction: null };
  }
  if (!smbOk && !amsOk) {
    return {
      kind: "error",
      title: "Verbindung",
      message,
      primaryAction: smbPresented?.primaryAction ?? amsPresented?.primaryAction ?? null,
    };
  }
  if (!smbOk) {
    return {
      kind: "error",
      title: "Server",
      message: smbPresented?.message ?? smb?.message ?? message,
      primaryAction: smbPresented?.primaryAction ?? null,
    };
  }
  return {
    kind: "error",
    title: "AMS-Bridge",
    message: amsPresented?.message ?? ams?.message ?? message,
    primaryAction: amsPresented?.primaryAction ?? null,
  };
}
