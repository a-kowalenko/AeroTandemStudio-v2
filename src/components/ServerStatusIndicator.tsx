import { Loader2, Server } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/configStore";
import { useAmsBridgeStore } from "../store/amsBridgeStore";
import { useServerStore } from "../store/serverStore";
import { useUiStore } from "../store/uiStore";
import { isAmsBridgeConfigured } from "../lib/amsLookup";
import { AMS_HEALTH_SPINNER_DELAY_MS } from "../lib/amsBridgeStatus";
import {
  presentHeaderConnection,
  presentHeaderRetryOutcome,
  type ConnectionDot,
} from "../lib/headerConnectionStatus";
import { cn } from "../lib/utils";
import {
  formatUploadProgressSnapshot,
  formatUploadProgressTooltip,
} from "../lib/uploadProgress";

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

/** Show spinner only after delay (quiet refresh) or immediately (loud check). */
function useDelayedSpinner(active: boolean, immediate: boolean): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    if (immediate) {
      setShow(true);
      return;
    }
    const id = window.setTimeout(
      () => setShow(true),
      AMS_HEALTH_SPINNER_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, [active, immediate]);
  return show;
}

export function ServerStatusIndicator({ className }: Props) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const smbPhase = useServerStore((s) => s.phase);
  const smbConnected = useServerStore((s) => s.connected);
  const smbMessage = useServerStore((s) => s.message);
  const smbRefreshing = useServerStore((s) => s.refreshing);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const checkConnection = useServerStore((s) => s.checkConnection);

  const amsPhase = useAmsBridgeStore((s) => s.phase);
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsMessage = useAmsBridgeStore((s) => s.message);
  const amsRefreshing = useAmsBridgeStore((s) => s.refreshing);
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

  const uploadDetail =
    smbPhase === "uploading" && uploadProgress
      ? formatUploadProgressTooltip(uploadProgress)
      : null;

  const view = presentHeaderConnection({
    smbPhase,
    smbConnected,
    smbMessage,
    uploadPercent:
      smbPhase === "uploading" ? (uploadProgress?.percent ?? 0) : null,
    uploadDetail,
    amsConfigured,
    amsPhase,
    amsConnected,
    amsMessage,
    smbRefreshing,
    amsRefreshing,
    amsDisplayName,
    serverUrl,
    login,
    password,
  });

  const amsChecking = amsConfigured && amsPhase === "checking";
  const loudChecking =
    retrying || smbPhase === "checking" || amsChecking;
  const quietRefreshing =
    !loudChecking &&
    (smbRefreshing || (amsConfigured && amsRefreshing));
  const showSpinner = useDelayedSpinner(
    loudChecking || quietRefreshing,
    loudChecking,
  );

  if (!view.visible) {
    return null;
  }

  const displayLabel =
    smbPhase === "uploading" && uploadProgress
      ? formatUploadProgressSnapshot(uploadProgress).label
      : loudChecking
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
    loudChecking ? "text-warning" : view.toneClass,
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
                loudChecking && view.smbDot !== "error"
                  ? "checking"
                  : view.smbDot
              }
            />
            <StatusDot
              tone={
                loudChecking && view.amsDot !== "error"
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
      {/* Fixed slot so the spinner never widens the chip when it appears. */}
      <span
        className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
        aria-hidden
      >
        {showSpinner ? (
          <Loader2 className="h-3 w-3 animate-spin opacity-80" />
        ) : null}
      </span>
    </>
  );

  if (canClick || retrying) {
    return (
      <button
        type="button"
        className={classNames}
        title={view.title}
        disabled={retrying}
        aria-busy={loudChecking || quietRefreshing || undefined}
        onClick={() => void onRetry()}
        onContextMenu={onContextMenu}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className={classNames}
      title={view.title}
      aria-busy={loudChecking || quietRefreshing || undefined}
    >
      {body}
    </div>
  );
}
