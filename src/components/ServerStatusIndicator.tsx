import { Server } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/configStore";
import { useAmsBridgeStore } from "../store/amsBridgeStore";
import { useServerStore } from "../store/serverStore";
import { useUiStore } from "../store/uiStore";
import { isAmsBridgeConfigured } from "../lib/amsLookup";
import {
  presentHeaderConnection,
  presentHeaderRetryOutcome,
  type ConnectionDot,
} from "../lib/headerConnectionStatus";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
};

function StatusDot({ tone }: { tone: ConnectionDot }) {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        tone === "ok" && "bg-success",
        tone === "error" && "bg-destructive",
        tone === "checking" && "animate-pulse bg-warning",
        tone === "idle" && "bg-muted/80",
      )}
    />
  );
}

export function ServerStatusIndicator({ className }: Props) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const smbPhase = useServerStore((s) => s.phase);
  const smbConnected = useServerStore((s) => s.connected);
  const smbMessage = useServerStore((s) => s.message);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const checkConnection = useServerStore((s) => s.checkConnection);

  const amsPhase = useAmsBridgeStore((s) => s.phase);
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsMessage = useAmsBridgeStore((s) => s.message);
  const amsStoreDisplayName = useAmsBridgeStore((s) => s.displayName);
  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);

  const config = useConfigStore((s) => s.config);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const openSettings = useUiStore((s) => s.openSettings);

  const login = config?.server_login ?? "";
  const password = config?.server_password ?? "";
  const serverUrl = config?.server_url ?? "";
  const amsConfigured = isAmsBridgeConfigured(config);
  const amsDisplayName =
    amsStoreDisplayName.trim() ||
    config?.ams_bridge_display_name?.trim() ||
    "";

  const view = presentHeaderConnection({
    smbPhase,
    smbConnected,
    smbMessage,
    uploadPercent:
      smbPhase === "uploading" ? (uploadProgress?.percent ?? 0) : null,
    uploadFilename: uploadProgress?.filename ?? null,
    amsConfigured,
    amsPhase,
    amsConnected,
    amsMessage,
    amsDisplayName,
    serverUrl,
    login,
    password,
  });

  if (!view.visible) {
    return null;
  }

  const amsChecking = amsConfigured && amsPhase === "checking";
  const checking =
    retrying || smbPhase === "checking" || amsChecking;

  const displayLabel =
    smbPhase === "uploading"
      ? t("chrome.server.uploadPercent", {
          percent: Math.round(uploadProgress?.percent ?? 0),
        })
      : checking
        ? t("errors.server.checking")
        : view.label;

  const canClick = view.canRetry && !retrying;

  async function onRetry() {
    if (!canClick) return;
    setRetrying(true);
    try {
      const [smbResult, amsResult] = await Promise.all([
        serverUrl.trim() ? checkConnection() : Promise.resolve(null),
        amsConfigured ? checkAmsHealth() : Promise.resolve(null),
      ]);
      const outcome = presentHeaderRetryOutcome({
        smb: smbResult,
        ams: amsResult,
        serverUrl,
        login,
        password,
      });
      if (!outcome) return;
      const options = {
        actions: outcome.actions,
        autoCloseSecs: outcome.autoCloseSecs ?? undefined,
        confirm:
          outcome.kind === "error" && outcome.primaryAction
            ? {
                secondaryLabel: t("common.actions.ok"),
                primaryLabel: outcome.primaryAction.label,
                onSecondary: () => closeDialog(),
                onPrimary: () => {
                  const focus = outcome.primaryAction?.openSettings;
                  closeDialog();
                  if (focus) openSettings(focus);
                },
              }
            : null,
      };
      // Structured rows (incl. failures) use SuccessDialog action list + tone icons.
      showSuccess(outcome.message, outcome.title, options);
    } finally {
      setRetrying(false);
    }
  }

  function onContextMenu(e: MouseEvent) {
    if (!view.contextMenuFocus) return;
    e.preventDefault();
    openSettings({
      tab: "server",
      focus: view.contextMenuFocus,
    });
  }

  const classNames = cn(
    "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs shadow-sm",
    checking ? "text-warning" : view.toneClass,
    canClick &&
      "cursor-pointer transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    retrying && "cursor-wait opacity-90",
    className,
  );

  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <Server className="h-3.5 w-3.5" />
        {view.amsDot ? (
          <span className="flex flex-col gap-0.5" aria-hidden>
            <StatusDot
              tone={
                checking && view.smbDot !== "error"
                  ? "checking"
                  : view.smbDot
              }
            />
            <StatusDot
              tone={
                checking && view.amsDot !== "error"
                  ? "checking"
                  : view.amsDot
              }
            />
          </span>
        ) : null}
      </span>
      <span className="relative inline-grid max-w-[14rem] text-left">
        {/* Keep width stable across Prüfe… / Verbunden / Teilweise verbunden. */}
        <span
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
          aria-hidden
        >
          {t("header.connection.titlePartial")}
        </span>
        <span
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
          aria-hidden
        >
          {t("header.connection.titleFailed")}
        </span>
        <span className="col-start-1 row-start-1 truncate">{displayLabel}</span>
      </span>
      {smbPhase === "uploading" && uploadProgress?.filename ? (
        <span className="max-w-[10rem] truncate text-muted">
          {uploadProgress.filename}
        </span>
      ) : null}
    </>
  );

  if (canClick || retrying) {
    return (
      <button
        type="button"
        className={classNames}
        title={view.title}
        disabled={retrying}
        aria-busy={retrying || undefined}
        onClick={() => void onRetry()}
        onContextMenu={onContextMenu}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={classNames} title={view.title}>
      {body}
    </div>
  );
}
