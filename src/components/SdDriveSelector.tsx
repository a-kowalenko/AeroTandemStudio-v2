import { useEffect } from "react";
import { HardDrive } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Button } from "./ui/button";
import { useConfigStore } from "../store/configStore";
import { useSdStore } from "../store/sdStore";
import { scanSdDrives } from "../lib/sdCard";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
  disabled?: boolean;
  /** Selecting a drive opens the file selector for that drive. */
  onOpenDrive: (drive: string) => void;
  /** Primary CTA: backup (and optional import) or open selector. */
  onPrimaryAction: (drive: string) => void;
};

export function SdDriveSelector({
  className,
  disabled = false,
  onOpenDrive,
  onPrimaryAction,
}: Props) {
  const config = useConfigStore((s) => s.config);
  const drives = useSdStore((s) => s.drives);
  const activeDrive = useSdStore((s) => s.activeDrive);
  const setDrives = useSdStore((s) => s.setDrives);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const phase = useSdStore((s) => s.phase);

  const selected =
    activeDrive && drives.some((d) => d.drive === activeDrive)
      ? activeDrive
      : drives[0]?.drive ?? "";

  const busyPhase =
    phase === "backing_up" || phase === "clearing" || phase === "importing";
  const hasDrive = Boolean(selected);
  const controlsDisabled = disabled || busyPhase;

  const canBackup =
    Boolean(config?.sd_auto_backup) && config?.sd_backup_mode !== "disabled";
  const ctaLabel =
    config?.sd_backup_mode === "auto"
      ? "Auto starten"
      : canBackup
        ? "Dateien wählen"
        : "Öffnen";

  async function refreshDrives() {
    try {
      const list = await scanSdDrives();
      setDrives(list);
      if (list.length === 0) {
        setActiveDrive(null);
        return;
      }
      const stillThere =
        activeDrive && list.some((d) => d.drive === activeDrive);
      if (!stillThere) setActiveDrive(list[0].drive);
    } catch {
      /* ignore — backend may be unavailable in browser preview */
    }
  }

  useEffect(() => {
    void refreshDrives();
    // Initial scan only — insert/remove events keep the store fresh afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount scan
  }, []);

  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      <span className="text-muted">SD:</span>
      <Select
        value={selected || undefined}
        disabled={controlsDisabled || drives.length === 0}
        onOpenChange={(open) => {
          if (open) void refreshDrives();
        }}
        onValueChange={(drive) => {
          setActiveDrive(drive);
          onOpenDrive(drive);
        }}
      >
        <SelectTrigger
          className="h-8 min-w-[5.5rem] max-w-[9rem] text-xs"
          title={
            drives.length === 0
              ? "Keine Action-Cam SD-Karte (DCIM) gefunden"
              : "SD-Karte wählen — öffnet Dateiauswahl"
          }
        >
          <span className="flex min-w-0 items-center gap-1">
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-primary" />
            <SelectValue placeholder="Keine SD" />
          </span>
        </SelectTrigger>
        <SelectContent>
          {drives.map((d) => (
            <SelectItem key={d.drive} value={d.drive}>
              {d.drive}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-8 text-xs"
        disabled={controlsDisabled || !hasDrive}
        title={
          config?.sd_backup_mode === "auto"
            ? "Backup, Import und Bereinigen laut Einstellungen starten"
            : "Dateiauswahl mit Optionen für Backup, Import und Bereinigen"
        }
        onClick={() => {
          if (selected) onPrimaryAction(selected);
        }}
      >
        {ctaLabel}
      </Button>
    </div>
  );
}
