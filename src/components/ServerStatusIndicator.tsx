import { Server } from "lucide-react";
import { useServerStore } from "../store/serverStore";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
};

export function ServerStatusIndicator({ className }: Props) {
  const phase = useServerStore((s) => s.phase);
  const connected = useServerStore((s) => s.connected);
  const message = useServerStore((s) => s.message);
  const uploadProgress = useServerStore((s) => s.uploadProgress);

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
    label = "Fehler";
    tone = "text-destructive";
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs shadow-sm",
        tone,
        className,
      )}
      title={message || "Server-Status"}
    >
      <Server className="h-3.5 w-3.5" />
      <span>{label}</span>
      {phase === "uploading" && uploadProgress?.filename ? (
        <span className="max-w-[10rem] truncate text-muted">{uploadProgress.filename}</span>
      ) : null}
    </div>
  );
}
