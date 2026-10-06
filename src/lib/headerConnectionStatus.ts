import type { AmsBridgePhase } from "@/store/amsBridgeStore";
import type { ServerPhase } from "@/store/serverStore";
import type {
  DialogActionKind,
  DialogActionStatus,
  DialogPrimaryAction,
  SettingsFocusTarget,
} from "@/store/uiStore";
import type { AmsBridgeHealthResult, ConnectionTestResult } from "@/lib/tauri";
import { tr } from "@/i18n";
import {
  amsOperatorTitle,
  amsBridgeStatusErrorTooltip,
  formatAmsConnectedTooltip,
  presentAmsBridgeError,
} from "./amsBridgeStatus";
import {
  mapServerErrorLabel,
  presentServerConnectionError,
  serverStatusErrorTooltip,
} from "./serverStatus";
import { presentSdUserMessage } from "./sdMessages";

/** `partial`: server answers, Login not proven yet. */
export type ConnectionDot = "ok" | "partial" | "error" | "checking" | "idle";

/** Left icon in the header connection chip. */
export type HeaderConnectionIcon = "server" | "upload" | "check";

/** Active / sticky transfer shown in the chip (priority: backup > upload). */
export type HeaderTransferKind =
  | "upload"
  | "serverBackup"
  | "serverBackupDone"
  | "serverBackupFailed"
  | "serverBackupCancelled";

export type HeaderSecondaryBackupInput = {
  state: string;
  percent: number;
  current?: number;
  total?: number;
  current_bytes?: number;
  total_bytes?: number;
  speed_bps?: number;
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
  /** Left-click opens backup detail popover (not reconnect). */
  canOpenBackupPopover: boolean;
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

function smbDot(
  phase: ServerPhase,
  connected: boolean,
  loginVerified: boolean,
): ConnectionDot {
  if (phase === "checking") return "checking";
  if (phase === "uploading") return connected ? "ok" : "idle";
  if (phase === "connected" || connected) return loginVerified ? "ok" : "partial";
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
  loginVerified: boolean,
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
  if (phase === "connected" || connected) {
    return loginVerified
      ? tr("header.connection.serverConnected")
      : tr("header.connection.serverReachableUnverified");
  }
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
  /** False while only a TCP probe answered. Defaults to true. */
  smbLoginVerified?: boolean;
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
  const backupCancelled = backup?.state === "cancelled";
  const uploading = input.smbPhase === "uploading";

  const smbVisible = !(input.smbPhase === "idle" && !input.smbConnected);
  const amsVisible = input.amsConfigured && input.amsPhase !== "idle";
  const backupVisible =
    backupActive || backupDone || backupFailed || backupCancelled;
  const visible = smbVisible || amsVisible || backupVisible;

  const smbChecking = input.smbPhase === "checking";
  const amsChecking = input.amsConfigured && input.amsPhase === "checking";
  const smbRefreshing = Boolean(input.smbRefreshing) && !smbChecking;
  const amsRefreshing =
    input.amsConfigured && Boolean(input.amsRefreshing) && !amsChecking;
  const smbOk = input.smbConnected || input.smbPhase === "connected";
  const smbLoginVerified = input.smbLoginVerified ?? true;
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
  } else if (backupCancelled) {
    transferKind = "serverBackupCancelled";
    leftIcon = "server";
    transferBusy = false;
    label = tr("header.connection.chipServerBackupCancelled");
    percentText = null;
    toneClass = "text-muted";
    liveMessage = tr("header.connection.chipServerBackupCancelled");
  } else if (backupFailed) {
    transferKind = "serverBackupFailed";
    leftIcon = "server";
    transferBusy = false;
    label = tr("header.connection.chipServerBackupFailed");
    percentText = null;
    toneClass = "text-destructive";
    liveMessage = backup?.message?.trim()
      ? presentSdUserMessage(backup.message)
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
  } else if (smbOk && !smbLoginVerified) {
    label = tr("chrome.server.reachable");
    toneClass = "text-warning";
  } else if (smbOk) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  } else if (amsOk) {
    label = tr("chrome.server.connected");
    toneClass = "text-success";
  }

  // Active transfer / done/cancelled flash / failed detail: no reconnect click.
  const canOpenBackupPopover =
    backupActive || backupDone || backupFailed || backupCancelled;
  const transferBlocksRetry =
    uploading || canOpenBackupPopover;

  const canRetry =
    visible &&
    !transferBlocksRetry &&
    !smbChecking &&
    !amsChecking &&
    !smbRefreshing &&
    !amsRefreshing;

  let contextMenuFocus: SettingsFocusTarget | null = null;
  if (canOpenBackupPopover) {
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
      smbLoginVerified,
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
  } else if (backupCancelled) {
    lines.push(tr("header.connection.chipServerBackupCancelled"));
  } else if (backupFailed) {
    const failMsg =
      presentSdUserMessage(backup?.message) ||
      tr("header.connection.chipServerBackupFailed");
    lines.push(failMsg);
  } else if (uploading && input.uploadDetail) {
    lines.push(input.uploadDetail);
  }
  if (canRetry) {
    lines.push(
      contextMenuFocus
        ? tr("header.connection.retryOrSettings")
        : tr("header.connection.retry"),
    );
  } else if (canOpenBackupPopover) {
    lines.push(tr("header.connection.backupPopoverHint"));
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
    smbDot: smbDot(input.smbPhase, input.smbConnected, smbLoginVerified),
    amsDot: input.amsConfigured
      ? amsDot(input.amsPhase, input.amsConnected)
      : null,
    title: lines.join("\n"),
    canRetry,
    canOpenBackupPopover,
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
const CONNECTION_SUCCESS_AUTO_CLOSE_SECS_MANY = 5;

function successAutoCloseSecs(actionCount: number): number {
  return actionCount >= 3
    ? CONNECTION_SUCCESS_AUTO_CLOSE_SECS_MANY
    : CONNECTION_SUCCESS_AUTO_CLOSE_SECS;
}

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
  label?: string;
  kind?: Extract<DialogActionKind, "server" | "backup">;
  settingsFocus?: SettingsFocusTarget;
}): DialogActionStatus {
  const label = opts.label ?? tr("header.connection.serverLabel");
  const kind = opts.kind ?? "server";
  if (opts.ok) {
    const parsed = parseServerSuccessDetail(opts.rawMessage);
    const summary =
      parsed.mode === "local"
        ? tr("header.connection.serverOkLocal")
        : parsed.mode === "remote"
          ? tr("header.connection.serverOkRemote")
          : tr("header.connection.serverOk");
    return {
      kind,
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
    settingsFocus: opts.settingsFocus,
  });
  const lines = presented.message
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = parseServerSuccessDetail(opts.rawMessage);
  const pathDetail =
    parsed.mode === "local" && parsed.detail ? parsed.detail : null;
  return {
    kind,
    label,
    tone: "error",
    summary: lines[0] ?? mapServerErrorLabel(opts.rawMessage),
    detail:
      lines.length > 1
        ? lines.slice(1).join("\n")
        : (pathDetail ?? undefined),
  };
}

export function presentBackupUrlMissingAction(): DialogActionStatus {
  return {
    kind: "backup",
    label: tr("header.connection.serverBackupLabel"),
    tone: "warning",
    summary: tr("header.connection.backupUrlMissing"),
    detail: tr("header.connection.backupUrlMissingDetail"),
  };
}

export function presentAmsConnectionAction(opts: {
  ok: boolean;
  rawMessage: string;
  displayName?: string | null;
  baseUrl?: string | null;
}): DialogActionStatus {
  const label = amsOperatorTitle();
  if (opts.ok) {
    const name = opts.displayName?.trim();
    const detail = opts.baseUrl?.trim();
    return {
      kind: "ams",
      label,
      tone: "success",
      summary: name
        ? tr("header.connection.amsOkNamed", { name })
        : tr("header.connection.amsOk"),
      detail: detail || undefined,
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

export type HeaderRetryBackupInput = {
  enabled: boolean;
  url: string;
  login: string;
  password: string;
  result: ConnectionTestResult | null;
};

export function presentHeaderRetryOutcome(opts: {
  smb: ConnectionTestResult | null;
  ams: AmsBridgeHealthResult | null;
  serverUrl: string;
  login: string;
  password: string;
  backup?: HeaderRetryBackupInput | null;
}): HeaderRetryOutcome | null {
  const { smb, ams } = opts;
  const backup = opts.backup?.enabled ? opts.backup : null;
  const backupUrl = backup?.url.trim() ?? "";
  const backupMissing = Boolean(backup && !backupUrl);
  const backupResult = backup && backupUrl ? backup.result : null;
  const backupChecked = Boolean(backup);
  if (!smb && !ams && !backupChecked) return null;

  const smbOk = !smb || smb.ok;
  const amsOk = !ams || ams.ok;
  const backupOk =
    !backupChecked || (Boolean(backupUrl) && Boolean(backupResult?.ok));
  const smbPresented = smb && !smb.ok
    ? presentServerConnectionError({
        rawMessage: smb.message,
        serverUrl: opts.serverUrl,
        login: opts.login,
        password: opts.password,
      })
    : null;
  const backupPresented = backupMissing
    ? {
        primaryAction: {
          label: tr("settings.sd.backup.setInServerProfile"),
          openSettings: {
            tab: "server" as const,
            focus: "server-backup-url" as const,
          },
        },
      }
    : backupResult && !backupResult.ok
      ? presentServerConnectionError({
          rawMessage: backupResult.message,
          serverUrl: backupUrl,
          login: backup?.login ?? "",
          password: backup?.password ?? "",
          settingsFocus: "server-backup-url",
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
  if (backupMissing) {
    actions.push(presentBackupUrlMissingAction());
  } else if (backupResult) {
    actions.push(
      presentServerConnectionAction({
        ok: backupResult.ok,
        rawMessage: backupResult.message,
        serverUrl: backupUrl,
        login: backup?.login ?? "",
        password: backup?.password ?? "",
        label: tr("header.connection.serverBackupLabel"),
        kind: "backup",
        settingsFocus: "server-backup-url",
      }),
    );
  }
  if (ams) {
    actions.push(
      presentAmsConnectionAction({
        ok: ams.ok,
        rawMessage: ams.message,
        displayName: ams.health?.display_name,
        baseUrl: ams.base_url,
      }),
    );
  }

  if (smbOk && backupOk && amsOk) {
    const checkedCount = [smb, backupResult, ams].filter(Boolean).length;
    const title =
      checkedCount >= 2
        ? tr("header.connection.titleAllOk")
        : smb || backupResult
          ? tr("header.connection.titleServerOk")
          : tr("header.connection.titleAmsOk");
    return {
      kind: "success",
      title,
      message: "",
      actions,
      primaryAction: null,
      autoCloseSecs: successAutoCloseSecs(actions.length),
    };
  }

  const primaryAction =
    smbPresented?.primaryAction ??
    backupPresented?.primaryAction ??
    amsPresented?.primaryAction ??
    null;

  const anyOk =
    Boolean(smb?.ok) || Boolean(backupResult?.ok) || Boolean(ams?.ok);
  const title =
    anyOk || backupMissing
      ? tr("header.connection.titlePartial")
      : tr("header.connection.titleFailed");

  return {
    kind: "error",
    title,
    message: "",
    actions,
    primaryAction,
    autoCloseSecs: null,
  };
}
