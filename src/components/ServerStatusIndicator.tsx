import { Server } from "lucide-react";
import type { MouseEvent } from "react";
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
  const smbPhase = useServerStore((s) => s.phase);
  const smbConnected = useServerStore((s) => s.connected);
  const smbMessage = useServerStore((s) => s.message);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const checkConnection = useServerStore((s) => s.checkConnection);

  const amsPhase = useAmsBridgeStore((s) => s.phase);
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsMessage = useAmsBridgeStore((s) => s.message);
  const amsVersion = useAmsBridgeStore((s) => s.version);
  const amsCapabilities = useAmsBridgeStore((s) => s.capabilities);
  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);

  const config = useConfigStore((s) => s.config);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const openSettings = useUiStore((s) => s.openSettings);

  const login = config?.server_login ?? "";
  const password = config?.server_password ?? "";
  const serverUrl = config?.server_url ?? "";
  const amsConfigured = isAmsBridgeConfigured(config);

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
    amsVersion,
    amsCapabilities,
    serverUrl,
    login,
    password,
  });

  if (!view.visible) {
    return null;
  }

  async function onRetry() {
    if (!view.canRetry) return;
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
    if (outcome.kind === "success") {
      showSuccess(outcome.message, outcome.title);
      return;
    }
    showError(outcome.message, outcome.title, {
      primaryAction: outcome.primaryAction ?? undefined,
    });
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
    view.toneClass,
    view.canRetry &&
      "cursor-pointer transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );

  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <Server className="h-3.5 w-3.5" />
        {view.amsDot ? (
          <span className="flex flex-col gap-0.5" aria-hidden>
            <StatusDot tone={view.smbDot} />
            <StatusDot tone={view.amsDot} />
          </span>
        ) : null}
      </span>
      <span>{view.label}</span>
      {smbPhase === "uploading" && uploadProgress?.filename ? (
        <span className="max-w-[10rem] truncate text-muted">
          {uploadProgress.filename}
        </span>
      ) : null}
    </>
  );

  if (view.canRetry) {
    return (
      <button
        type="button"
        className={classNames}
        title={view.title}
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
