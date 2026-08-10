import { Server } from "lucide-react";
import { useServerStore } from "../store/serverStore";
import { useUiStore } from "../store/uiStore";
import {
  mapServerErrorDetail,
  mapServerErrorLabel,
} from "../lib/serverStatus";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
};

export function ServerStatusIndicator({ className }: Props) {
  const phase = useServerStore((s) => s.phase);
  const connected = useServerStore((s) => s.connected);
  const message = useServerStore((s) => s.message);
  const uploadProgress = useServerStore((s) => s.uploadProgress);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);

  if (phase === "idle" && !connected) {
    return null;
  }

  let label = "Server";
  let tone = "text-muted";
  if (phase === "checking") {
    label = "Prüfe…";
    tone = "text-warning";
  } else if (phase === "uploading") {
    const pct = uploadProgress?.percent ?? 0;
    label = `Upload ${pct.toFixed(0)}%`;
    tone = "text-primary";
  } else if (connected || phase === "connected") {
    label = "Verbunden";
    tone = "text-success";
  } else if (phase === "error") {
    label = mapServerErrorLabel(message);
    tone = "text-destructive";
  }

  const canRetry = phase === "error" || phase === "connected";
  const title = canRetry
    ? message
      ? `${message}\nKlicken zum erneuten Prüfen`
      : "Klicken zum erneuten Prüfen"
    : message || "Server-Status";

  async function onRetry() {
    if (!canRetry) return;
    const result = await checkConnection();
    if (result.ok) showSuccess(result.message, "Server");
    else showError(mapServerErrorDetail(result.message).text, "Server");
  }

  const classNames = cn(
    "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs shadow-sm",
    tone,
    canRetry &&
      "cursor-pointer transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );

  const body = (
    <>
      <Server className="h-3.5 w-3.5" />
      <span>{label}</span>
      {phase === "uploading" && uploadProgress?.filename ? (
        <span className="max-w-[10rem] truncate text-muted">
          {uploadProgress.filename}
        </span>
      ) : null}
    </>
  );

  if (canRetry) {
    return (
      <button
        type="button"
        className={classNames}
        title={title}
        onClick={() => void onRetry()}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={classNames} title={title}>
      {body}
    </div>
  );
}
