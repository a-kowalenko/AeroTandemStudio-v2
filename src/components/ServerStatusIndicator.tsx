import { Check, Loader2, Server, Upload } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/configStore";
import { useAmsBridgeStore } from "../store/amsBridgeStore";
import { useSdStore } from "../store/sdStore";
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
  formatSecondaryBackupCompactParts,
  formatUploadProgressTooltip,
} from "../lib/uploadProgress";
import { cancelSecondaryBackup } from "../lib/tauri";
import {
  CancelSecondaryBackupConfirmDialog,
  type CancelSecondaryBackupConfirmChoice,
} from "./CancelSecondaryBackupConfirmDialog";
import { SecondaryBackupPopover } from "./SecondaryBackupPopover";
import { PostUpdateConnectionHintPopover } from "./PostUpdateConnectionHintPopover";
import { usePostUpdateConnectionHint } from "../hooks/usePostUpdateConnectionHint";

type Props = {
  className?: string;
  /** macOS post-update hint when SMB + AMS stay unreachable after a version change. */
  postUpdateHintEnabled?: boolean;
  appVersion?: string;
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

/** Announce transfer progress sparsely (state change or every ~5%). */
function useSparseLiveMessage(message: string | null, percentText: string | null) {
  const [live, setLive] = useState("");
  const lastKey = useRef("");

  useEffect(() => {
    if (!message) {
      lastKey.current = "";
      return;
    }
    const pctMatch = percentText?.match(/(\d+)/);
    const bucket = pctMatch ? Math.floor(Number(pctMatch[1]) / 5) : -1;
    const key = `${message}|${bucket}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setLive(message);
  }, [message, percentText]);

  return live;
}

export function ServerStatusIndicator({
  className,
  postUpdateHintEnabled = false,
  appVersion = "",
}: Props) {
  const { t } = useTranslation();
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const smbPhase = useServerStore((s) => s.phase);
  const smbConnected = useServerStore((s) => s.connected);
  const smbMessage = useServerStore((s) => s.message);
  const smbRefreshing = useServerStore((s) => s.refreshing);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const checkConnection = useServerStore((s) => s.checkConnection);

  const secondaryBackup = useSdStore((s) => s.secondaryBackup);
  const setSecondaryBackup = useSdStore((s) => s.setSecondaryBackup);

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
    secondaryBackup,
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
  const delayedSpinner = useDelayedSpinner(
    loudChecking || quietRefreshing,
    loudChecking,
  );
  const showSpinner = !view.percentText && delayedSpinner;

  const liveMessage = useSparseLiveMessage(view.liveMessage, view.percentText);

  // Close popover when backup chip leaves; keep open across progress updates.
  useEffect(() => {
    if (!view.canOpenBackupPopover) {
      setPopoverOpen(false);
      setConfirmOpen(false);
      setCancelling(false);
    }
  }, [view.canOpenBackupPopover]);

  // Auto-close shortly after done / cancelled flash.
  useEffect(() => {
    const state = secondaryBackup?.state;
    if (state !== "done" && state !== "cancelled") return;
    if (!popoverOpen) return;
    const id = window.setTimeout(() => setPopoverOpen(false), 1800);
    return () => window.clearTimeout(id);
  }, [secondaryBackup?.state, secondaryBackup?.job_id, popoverOpen]);

  // Click outside + Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (confirmOpen) return;
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setPopoverOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !confirmOpen) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [popoverOpen, confirmOpen]);

  // Clear cancelling when terminal event arrives.
  useEffect(() => {
    const state = secondaryBackup?.state;
    if (
      state === "cancelled" ||
      state === "failed" ||
      state === "done"
    ) {
      setCancelling(false);
    }
  }, [secondaryBackup?.state, secondaryBackup?.job_id]);

  const displayLabel = loudChecking && !view.transferKind
    ? t("errors.server.checking")
    : view.label;

  const canClickRetry = view.canRetry && !retrying;
  const canClickPopover = view.canOpenBackupPopover;
  const interactive = canClickRetry || canClickPopover || retrying;

  const backupPopoverActive = popoverOpen && Boolean(secondaryBackup);
  const postUpdateHint = usePostUpdateConnectionHint({
    enabled: postUpdateHintEnabled,
    appVersion,
    backupPopoverActive,
  });

  const backupCompact = formatSecondaryBackupCompactParts(
    secondaryBackup
      ? {
          percent: secondaryBackup.percent,
          current_bytes: secondaryBackup.current_bytes,
          total_bytes: secondaryBackup.total_bytes,
          speed_bps: secondaryBackup.speed_bps,
        }
      : null,
  );

  const filesLabel =
    secondaryBackup &&
    typeof secondaryBackup.current === "number" &&
    typeof secondaryBackup.total === "number" &&
    secondaryBackup.total > 0
      ? t("header.connection.serverBackupFiles", {
          current: secondaryBackup.current,
          total: secondaryBackup.total,
        })
      : null;

  async function onRetry() {
    if (!canClickRetry) return;
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
      showSuccess(outcome.message, outcome.title, options);
    } finally {
      setRetrying(false);
    }
  }

  function onChipClick() {
    if (canClickPopover) {
      setPopoverOpen((v) => !v);
      return;
    }
    void onRetry();
  }

  function onContextMenu(e: MouseEvent) {
    if (!view.contextMenuFocus) return;
    e.preventDefault();
    openSettings({
      tab: "server",
      focus: view.contextMenuFocus,
    });
  }

  function onDismissBackup() {
    setSecondaryBackup(null);
    setPopoverOpen(false);
  }

  function onCancelRequest() {
    setConfirmOpen(true);
  }

  async function onConfirmChoose(choice: CancelSecondaryBackupConfirmChoice) {
    setConfirmOpen(false);
    if (choice !== "cancel") return;
    setCancelling(true);
    try {
      await cancelSecondaryBackup();
    } catch {
      setCancelling(false);
    }
  }

  if (!view.visible) {
    return null;
  }

  const classNames = cn(
    "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs shadow-sm",
    loudChecking && !view.transferKind ? "text-warning" : view.toneClass,
    interactive &&
      "cursor-pointer transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    retrying && "cursor-wait opacity-90",
    className,
  );

  const LeftIcon =
    view.leftIcon === "upload"
      ? Upload
      : view.leftIcon === "check"
        ? Check
        : Server;

  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <LeftIcon
          className={cn(
            "h-3.5 w-3.5",
            view.transferBusy && "ats-upload-icon-active",
          )}
          aria-hidden
        />
        {view.amsDot && view.leftIcon === "server" ? (
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
        {!view.transferKind ? (
          <>
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
          </>
        ) : null}
        <span className="col-start-1 row-start-1 truncate">{displayLabel}</span>
      </span>
      <span
        className="inline-flex h-3 min-w-3 shrink-0 items-center justify-center"
        aria-hidden
      >
        {view.percentText ? (
          <span className="relative inline-grid text-right tabular-nums">
            <span
              className="invisible col-start-1 row-start-1 whitespace-nowrap"
              aria-hidden
            >
              {t("header.connection.percent", { percent: 100 })}
            </span>
            <span className="col-start-1 row-start-1">{view.percentText}</span>
          </span>
        ) : showSpinner ? (
          <Loader2 className="h-3 w-3 animate-spin opacity-80" />
        ) : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {liveMessage}
      </span>
    </>
  );

  return (
    <div ref={rootRef} className="relative">
      {interactive ? (
        <button
          type="button"
          className={classNames}
          title={view.title}
          disabled={retrying}
          aria-busy={
            view.transferBusy || loudChecking || quietRefreshing || undefined
          }
          aria-expanded={canClickPopover ? popoverOpen : undefined}
          aria-controls={canClickPopover ? popoverId : undefined}
          onClick={onChipClick}
          onContextMenu={onContextMenu}
        >
          {body}
        </button>
      ) : (
        <div
          className={classNames}
          title={view.title}
          aria-busy={
            view.transferBusy || loudChecking || quietRefreshing || undefined
          }
          onContextMenu={onContextMenu}
        >
          {body}
        </div>
      )}

      <div id={popoverId}>
        <SecondaryBackupPopover
          open={backupPopoverActive}
          compact={backupCompact}
          state={secondaryBackup?.state ?? ""}
          filesLabel={filesLabel}
          message={secondaryBackup?.message ?? null}
          parallelUploadPercent={
            smbPhase === "uploading"
              ? (uploadProgress?.percent ?? 0)
              : null
          }
          cancelling={cancelling}
          onCancelRequest={onCancelRequest}
          onDismiss={onDismissBackup}
        />
        <PostUpdateConnectionHintPopover
          open={postUpdateHint.open}
          onAcknowledge={() => void postUpdateHint.acknowledge()}
        />
      </div>

      <CancelSecondaryBackupConfirmDialog
        open={confirmOpen}
        onChoose={(choice) => void onConfirmChoose(choice)}
      />
    </div>
  );
}
