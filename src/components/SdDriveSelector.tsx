import { useEffect, useState } from "react";
import { Eject, HardDrive } from "lucide-react";
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
import { useUiStore } from "../store/uiStore";
import { ejectSdCard, scanSdDrives } from "../lib/sdCard";
import { cn } from "../lib/utils";

type Props = {
  className?: string;
  disabled?: boolean;
  /** Selecting a drive opens the file selector for that drive. */
  onOpenDrive: (drive: string) => void;
  /** Primary CTA: backup (and optional import) or open selector. */
  onPrimaryAction: (drive: string) => void;
};

function driveLabel(drive: string): string {
  // Prefer the volume name on Unix mounts for a compact macOS-like row.
  const trimmed = drive.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  if (parts.length > 1 && (trimmed.startsWith("/") || trimmed.includes("\\"))) {
    return parts[parts.length - 1] || drive;
  }
  return drive;
}

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
  const showWarning = useUiStore((s) => s.showWarning);
  const showSuccess = useUiStore((s) => s.showSuccess);

  const [open, setOpen] = useState(false);
  const [ejecting, setEjecting] = useState<string | null>(null);

  const selected =
    activeDrive && drives.some((d) => d.drive === activeDrive)
      ? activeDrive
      : drives[0]?.drive ?? "";

  const busyPhase =
    phase === "backing_up" || phase === "clearing" || phase === "importing";
  const hasDrive = Boolean(selected);
  const controlsDisabled = disabled || busyPhase || ejecting !== null;

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

  async function handleEject(drive: string) {
    if (ejecting || busyPhase || disabled) return;
    setOpen(false);
    setEjecting(drive);
    try {
      await ejectSdCard(drive);
      showSuccess(`SD-Karte ausgeworfen:\n${drive}`, "Ausgeworfen", {
        autoCloseSecs: 4,
      });
      await refreshDrives();
    } catch (e) {
      showWarning(
        `Auswerfen fehlgeschlagen:\n${String(e)}\n\nBitte die Karte manuell sicher entfernen.`,
      );
      await refreshDrives();
    } finally {
      setEjecting(null);
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
        open={open}
        disabled={controlsDisabled || drives.length === 0}
        onOpenChange={(next) => {
          if (ejecting) return;
          setOpen(next);
          if (next) void refreshDrives();
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
        <SelectContent className="min-w-[11rem]">
          {drives.map((d) => {
            const label = driveLabel(d.drive);
            const isEjecting = ejecting === d.drive;
            return (
              <div key={d.drive} className="relative flex items-center">
                <SelectItem
                  value={d.drive}
                  className="w-full pr-9"
                  title={d.drive}
                >
                  <span className="block max-w-[9rem] truncate">{label}</span>
                </SelectItem>
                <button
                  type="button"
                  className={cn(
                    "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted transition-colors",
                    "hover:bg-black/10 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                  title={`„${label}“ auswerfen`}
                  aria-label={`SD-Karte ${label} auswerfen`}
                  disabled={busyPhase || disabled || ejecting !== null}
                  onPointerDown={(e) => {
                    // Prevent Radix Select from selecting the row / closing via item.
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleEject(d.drive);
                  }}
                >
                  <Eject
                    className={cn("h-3.5 w-3.5", isEjecting && "animate-pulse")}
                  />
                </button>
              </div>
            );
          })}
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
            ? "Backup, Import, Bereinigen und Auswerfen laut Einstellungen starten"
            : "Dateiauswahl mit Optionen für Backup, Import, Bereinigen und Auswerfen"
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
