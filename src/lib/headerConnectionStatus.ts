import type { AmsBridgePhase } from "@/store/amsBridgeStore";
import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogActionStatus,
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";
import type { AmsBridgeHealthResult, ConnectionTestResult } from "@/lib/tauri";
import { tr } from "@/i18n";
import {
  amsOperatorTitle,
  amsBridgeStatusErrorTooltip,
  amsConnectionLabel,
  formatAmsConnectedTooltip,
  formatAmsConnectionDialogTitle,
  presentAmsBridgeError,
} from "./amsBridgeStatus";
import {
  mapServerErrorLabel,
  presentServerConnectionError,
  serverStatusErrorTooltip,
} from "./serverStatus";

export type ConnectionDot = "ok" | "error" | "checking" | "idle";

/** Left icon in the header connection chip. */
export type HeaderConnectionIcon = "server" | "upload" | "check";

/** Active / sticky transfer shown in the chip (priority: upload > backup). */
export type HeaderTransferKind =
  | "upload"
  | "serverBackup"
  | "serverBackupDone"
  | "serverBackupFailed";

export type HeaderSecondaryBackupInput = {
  state: string;
  percent: number;
  current?: number;
  total?: number;
  file_name?: string | null;
  message?: string | null;
} | null;

export type HeaderConnectionView = {
  visible: boolean;
  label: string;
  /** Right-side percent, e.g. `"42%"` — null when idle / checking / done flash. */
  percentText: string | null;
  toneClass: string;
  leftIcon: HeaderConnectionIcon;
  /** Animate upload icon (active transfer only). */
  transferBusy: boolean;
  transferKind: HeaderTransferKind | null;
  /** Sparse live region text for screen readers. */
  liveMessage: string | null;
  smbDot: ConnectionDot;
  amsDot: ConnectionDot | null;
  title: string;
  canRetry: boolean;
  contextMenuFocus: SettingsFocusTarget | null;
};

function isBackupActive(state: string): boolean {
  return state === "started" || state === "progress";
}

function formatPercentText(percent: number): string {
  return tr("header.connection.percent", {
    percent: Math.round(percent),
  });
}

function backupTooltipDetail(backup: NonNullable<HeaderSecondaryBackupInput>): string {
  const parts: string[] = [];
  if (backup.file_name?.trim()) {
    parts.push(backup.file_name.trim());
  }
  if (
    typeof backup.current === "number" &&
    typeof backup.total === "number" &&
    backup.total > 0
  ) {
    parts.push(
      tr("header.connection.serverBackupFiles", {
        current: backup.current,
        total: backup.total,
      }),
    );
  }
  return parts.join(" · ");
}

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
  refreshing?: boolean,
): string {
  if (phase === "checking" || refreshing) {
    return tr("header.connection.serverChecking");
  }
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
  displayName?: string,
  refreshing?: boolean,
): string {
  if (phase === "checking" || refreshing) {
    return tr("header.connection.amsChecking", { title: amsOperatorTitle() });
  }
  if (phase === "error") {
    return amsBridgeStatusErrorTooltip(message);
  }
  if (phase === "connected" || connected) {
    return formatAmsConnectedTooltip(displayName);
  }
  return tr("header.connection.amsNotChecked", { title: amsOperatorTitle() });
}

export function presentHeaderConnection(input: {
  smbPhase: ServerPhase;
  smbConnected: boolean;
  smbMessage: string;
  uploadPercent: number | null;
  /** Extra upload tooltip lines (bytes / files done); no single filename. */
  uploadDetail: string | null;
  /** SD server-backup (secondary SMB mirror) progress. */
  secondaryBackup?: HeaderSecondaryBackupInput;
  amsConfigured: boolean;
  amsPhase: AmsBridgePhase;
  amsConnected: boolean;
  amsMessage: string;
  /** Quiet background revalidation — label stays; UI may show a spinner. */
  smbRefreshing?: boolean;
  /** Quiet background revalidation — label stays; UI may show a spinner. */
  amsRefreshing?: boolean;
  amsDisplayName?: string;
  serverUrl: string;
  login: string;
  password: string;
}): HeaderConnectionView {
  const backup = input.secondaryBackup ?? null;
  const backupActive = Boolean(backup && isBackupActive(backup.state));
  const backupDone = backup?.state === "done";
  const backupFailed = backup?.state === "failed";
  const uploading = input.smbPhase === "uploading";

  const smbVisible = !(input.smbPhase === "idle" && !input.smbConnected);
  const amsVisible = input.amsConfigured && input.amsPhase !== "idle";
  const backupVisible = backupActive || backupDone || backupFailed;
  const visible = smbVisible || amsVisible || backupVisible;

  const smbChecking = input.smbPhase === "checking";
  const amsChecking = input.amsConfigured && input.amsPhase === "checking";
  const smbRefreshing = Boolean(input.smbRefreshing) && !smbChecking;
  const amsRefreshing =
    input.amsConfigured && Boolean(input.amsRefreshing) && !amsChecking;
  const smbOk = input.smbConnected || input.smbPhase === "connected";
  const amsOk = input.amsConnected || input.amsPhase === "connected";
  const smbError = input.smbPhase === "error";
  const amsError = input.amsConfigured && input.amsPhase === "error";

  let label = tr("app.server.title");
  let toneClass = "text-muted";
  let percentText: string | null = null;
  let leftIcon: HeaderConnectionIcon = "server";
  let transferBusy = false;
  let transferKind: HeaderTransferKind | null = null;
  let liveMessage: string | null = null;

  // Priority: Server-Backup > Vorgang-Upload > Checking > Connected/Error
  // (Upload is usually already visible in the progress panel.)
  if (backupActive && backup) {
    const pct = backup.percent;
    transferKind = "serverBackup";
    leftIcon = "upload";
    transferBusy = true;
    label = tr("header.connection.chipServerBackup");
    percentText = formatPercentText(pct);
    toneClass = "text-primary";
    liveMessage = tr("header.connection.liveServerBackup", {
      percent: Math.round(pct),
    });
  } else if (backupDone) {
    transferKind = "serverBackupDone";
    leftIcon = "check";
    transferBusy = false;
    label = tr("header.connection.chipServerBackupDone");
    percentText = null;
    toneClass = "text-success";
    liveMessage = tr("header.connection.chipServerBackupDone");
  } else if (backupFailed) {
    transferKind = "serverBackupFailed";
    leftIcon = "server";
    transferBusy = false;
    label = tr("header.connection.chipServerBackupFailed");
    percentText = null;
    toneClass = "text-destructive";
    liveMessage = backup?.message?.trim()
      ? backup.message.trim()
      : tr("header.connection.chipServerBackupFailed");
  } else if (uploading) {
    const pct = input.uploadPercent ?? 0;
    transferKind = "upload";
    leftIcon = "upload";
    transferBusy = true;
    label = tr("header.connection.chipUpload");
    percentText = formatPercentText(pct);
    toneClass = "text-primary";
    liveMessage = tr("header.connection.liveUpload", {
      percent: Math.round(pct),
    });
  } else if (smbChecking || amsChecking) {
    // Loud checks only — quiet refresh keeps the last label (spinner in UI).
    label = tr("common.actions.checking");
    toneClass = "text-warning";
  } else if (smbError && amsError) {
    label = mapServerErrorLabel(input.smbMessage);
    toneClass = "text-destructive";
  } else if (smbError) {
    label = mapServerErrorLabel(input.smbMessage);
    toneClass = "text-destructive";
  } else if (amsError && smbOk) {
    label = tr("header.connection.titlePartial");
    toneClass = "text-warning";
  } else if (amsError) {
    label = tr("header.connection.titleFailed");
    toneClass = "text-destructive";
  } else if (smbOk) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  } else if (amsOk) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  }

  // Active transfer / done flash: no reconnect click. Failed stays clickable.
  const transferBlocksRetry = uploading || backupActive || backupDone;

  const canRetry =
    visible &&
    !transferBlocksRetry &&
    !smbChecking &&
    !amsChecking &&
    !smbRefreshing &&
    !amsRefreshing;

  let contextMenuFocus: SettingsFocusTarget | null = null;
  if (backupFailed || backupActive || backupDone) {
    contextMenuFocus = "server-backup-url";
  } else if (smbError) {
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
      smbRefreshing,
    ),
  ];
  if (input.amsConfigured) {
    lines.push(
      amsTooltipLine(
        input.amsPhase,
        input.amsConnected,
        input.amsMessage,
        input.amsDisplayName,
        amsRefreshing,
      ),
    );
  }
  if (backupActive && backup) {
    const detail = backupTooltipDetail(backup);
    lines.push(
      detail
        ? tr("header.connection.serverBackupWithDetail", {
            percent: Math.round(backup.percent),
            detail,
          })
        : tr("header.connection.serverBackupRunning", {
            percent: Math.round(backup.percent),
          }),
    );
    if (uploading) {
      lines.push(
        tr("header.connection.parallelUpload", {
          percent: Math.round(input.uploadPercent ?? 0),
        }),
      );
    }
  } else if (backupDone) {
    lines.push(tr("header.connection.chipServerBackupDone"));
  } else if (backupFailed) {
    const failMsg =
      backup?.message?.trim() || tr("header.connection.chipServerBackupFailed");
    lines.push(failMsg);
  } else if (uploading && input.uploadDetail) {
    lines.push(input.uploadDetail);
  }
  if (canRetry) {
    lines.push(
      backupFailed
        ? tr("header.connection.backupFailedHint")
        : contextMenuFocus
          ? tr("header.connection.retryOrSettings")
          : tr("header.connection.retry"),
    );
  } else if (contextMenuFocus && (backupActive || backupDone)) {
    lines.push(tr("header.connection.backupSettingsHint"));
  }

  return {
    visible,
    label,
    percentText,
    toneClass,
    leftIcon,
    transferBusy,
    transferKind,
    liveMessage,
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
  /** Optional footnote under action rows (usually empty). */
  message: string;
  actions: DialogActionStatus[];
  primaryAction: DialogPrimaryAction | null;
  /** Auto-dismiss only when every checked target is OK. */
  autoCloseSecs: number | null;
};

const CONNECTION_SUCCESS_AUTO_CLOSE_SECS = 3;

/** Extract path/share detail from Rust connection success messages. */
export function parseServerSuccessDetail(raw: string): {
  mode: "local" | "remote" | "unknown";
  detail: string | null;
} {
  const text = raw.trim();
  const local = text.match(/^Lokaler Pfad erreichbar:\s*(.+)$/i);
  if (local?.[1]) {
    return { mode: "local", detail: local[1].trim() };
  }
  const remote = text.match(
    /^Verbindung zum Server erfolgreich\s*\((.+)\)$/i,
  );
  if (remote?.[1]) {
    return { mode: "remote", detail: remote[1].trim() };
  }
  const localMissing = text.match(/^Lokaler Pfad nicht gefunden:\s*(.+)$/i);
  if (localMissing?.[1]) {
    return { mode: "local", detail: localMissing[1].trim() };
  }
  return { mode: "unknown", detail: text || null };
}

export function presentServerConnectionAction(opts: {
  ok: boolean;
  rawMessage: string;
  serverUrl: string;
  login: string;
  password: string;
}): DialogActionStatus {
  const label = tr("header.connection.serverLabel");
  if (opts.ok) {
    const parsed = parseServerSuccessDetail(opts.rawMessage);
    const summary =
      parsed.mode === "local"
        ? tr("header.connection.serverOkLocal")
        : parsed.mode === "remote"
          ? tr("header.connection.serverOkRemote")
          : tr("header.connection.serverOk");
    return {
      kind: "server",
      label,
      tone: "success",
      summary,
      detail: parsed.detail ?? undefined,
    };
  }

  const presented = presentServerConnectionError({
    rawMessage: opts.rawMessage,
    serverUrl: opts.serverUrl,
    login: opts.login,
    password: opts.password,
    omitSettingsAction: true,
  });
  const lines = presented.message
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = parseServerSuccessDetail(opts.rawMessage);
  const pathDetail =
    parsed.mode === "local" && parsed.detail ? parsed.detail : null;
  return {
    kind: "server",
    label,
    tone: "error",
    summary: lines[0] ?? mapServerErrorLabel(opts.rawMessage),
    detail:
      lines.length > 1
        ? lines.slice(1).join("\n")
        : (pathDetail ?? undefined),
  };
}

export function presentAmsConnectionAction(opts: {
  ok: boolean;
  rawMessage: string;
  displayName?: string | null;
}): DialogActionStatus {
  const label = amsConnectionLabel(opts.displayName);
  if (opts.ok) {
    return {
      kind: "ams",
      label,
      tone: "success",
      summary: tr("header.connection.amsOk"),
    };
  }
  const presented = presentAmsBridgeError({
    rawMessage: opts.rawMessage,
    omitSettingsAction: true,
  });
  const lines = presented.message
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    kind: "ams",
    label,
    tone: "error",
    summary: lines[0] ?? presented.message,
    detail: lines.length > 1 ? lines.slice(1).join("\n") : undefined,
  };
}

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

  const actions: DialogActionStatus[] = [];
  if (smb) {
    actions.push(
      presentServerConnectionAction({
        ok: smb.ok,
        rawMessage: smb.message,
        serverUrl: opts.serverUrl,
        login: opts.login,
        password: opts.password,
      }),
    );
  }
  if (ams) {
    actions.push(
      presentAmsConnectionAction({
        ok: ams.ok,
        rawMessage: ams.message,
        displayName: ams.health?.display_name,
      }),
    );
  }

  if (smbOk && amsOk) {
    const title =
      smb && ams
        ? tr("header.connection.titleAllOk")
        : smb
          ? tr("header.connection.titleServerOk")
          : formatAmsConnectionDialogTitle(ams?.health?.display_name);
    return {
      kind: "success",
      title,
      message: "",
      actions,
      primaryAction: null,
      autoCloseSecs: CONNECTION_SUCCESS_AUTO_CLOSE_SECS,
    };
  }

  const primaryAction =
    smbPresented?.primaryAction ?? amsPresented?.primaryAction ?? null;

  if (!smbOk && !amsOk && smb && ams) {
    return {
      kind: "error",
      title: tr("header.connection.titleFailed"),
      message: "",
      actions,
      primaryAction,
      autoCloseSecs: null,
    };
  }

  if (!smbOk && smb && ams && amsOk) {
    return {
      kind: "error",
      title: tr("header.connection.titlePartial"),
      message: "",
      actions,
      primaryAction: smbPresented?.primaryAction ?? null,
      autoCloseSecs: null,
    };
  }

  if (!amsOk && ams && smb && smbOk) {
    return {
      kind: "error",
      title: tr("header.connection.titlePartial"),
      message: "",
      actions,
      primaryAction: amsPresented?.primaryAction ?? null,
      autoCloseSecs: null,
    };
  }

  if (!smbOk) {
    return {
      kind: "error",
      title: tr("header.connection.titleFailed"),
      message: "",
      actions,
      primaryAction: smbPresented?.primaryAction ?? null,
      autoCloseSecs: null,
    };
  }

  return {
    kind: "error",
    title: tr("header.connection.titleFailed"),
    message: "",
    actions,
    primaryAction: amsPresented?.primaryAction ?? null,
    autoCloseSecs: null,
  };
}
