import { HardDrive } from "lucide-react";
import { useSdStore } from "../store/sdStore";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
};

export function SdStatusIndicator({ className }: Props) {
  const monitoring = useSdStore((s) => s.monitoring);
  const phase = useSdStore((s) => s.phase);
  const activeDrive = useSdStore((s) => s.activeDrive);
  const progress = useSdStore((s) => s.backupProgress);
  const drives = useSdStore((s) => s.drives);

  if (!monitoring && drives.length === 0 && phase === "idle") {
    return null;
  }

  let label = "SD bereit";
  if (phase === "backing_up") label = "Backup…";
  else if (phase === "clearing") label = "Leeren…";
  else if (phase === "importing") label = "Import…";
  else if (phase === "confirming") label = "Bestätigung";
  else if (phase === "detected" || drives.length > 0) label = "SD erkannt";
  else if (monitoring) label = "Überwachung";

  const driveLabel = activeDrive || drives[0]?.drive || "";

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs text-muted shadow-sm",
        className,
      )}
      title={
        driveLabel
          ? `SD-Karten Überwachung — Laufwerk ${driveLabel}`
          : "SD-Karten Überwachung aktiv"
      }
    >
      <HardDrive className="h-3.5 w-3.5 text-primary" />
      <span>{label}</span>
      {driveLabel && <span className="font-medium text-foreground">{driveLabel}</span>}
      {phase === "backing_up" && progress && (
        <span className="tabular-nums">
          {progress.current_mb.toFixed(0)}/{progress.total_mb.toFixed(0)} MB
          {progress.speed_mbps > 0 ? ` · ${progress.speed_mbps.toFixed(1)} MB/s` : ""}
        </span>
      )}
    </div>
  );
}
