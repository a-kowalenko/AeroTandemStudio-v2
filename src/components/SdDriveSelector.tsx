import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, HardDrive } from "lucide-react";
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
import { ejectSdCard, scanSdDrives } from "../lib/sdCard";
import {
  resolveSdEjectDetail,
  showSdEjectToast,
} from "../lib/sdEjectToast";
import {
  compactDriveLabel,
  driveTooltip,
  listDriveLabel,
  usefulVolumeName,
} from "../lib/sdDriveLabel";
import { cn } from "../lib/utils";

/** Classic macOS / SF Symbol eject glyph (triangle over bar). */
function EjectIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 4.2 4.85 14.4A1.1 1.1 0 0 0 5.78 16h12.44a1.1 1.1 0 0 0 .93-1.6L12 4.2Z" />
      <rect x="5.25" y="17.6" width="13.5" height="2.35" rx="0.7" />
    </svg>
  );
}

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
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const drives = useSdStore((s) => s.drives);
  const activeDrive = useSdStore((s) => s.activeDrive);
  const setDrives = useSdStore((s) => s.setDrives);
  const setActiveDrive = useSdStore((s) => s.setActiveDrive);
  const phase = useSdStore((s) => s.phase);
  const monitoring = useSdStore((s) => s.monitoring);
  const [open, setOpen] = useState(false);
  const [ejecting, setEjecting] = useState<string | null>(null);
  /** True while the user has the drive dropdown open (ignore programmatic value sync). */
  const userPickingDriveRef = useRef(false);

  const selected =
    activeDrive && drives.some((d) => d.drive === activeDrive)
      ? activeDrive
      : drives[0]?.drive ?? "";

  const selectedInfo = drives.find((d) => d.drive === selected);
  const busyPhase =
    phase === "backing_up" || phase === "clearing" || phase === "importing";
  const hasDrive = Boolean(selected);
  const controlsDisabled = disabled || busyPhase || ejecting !== null;
  const watching = monitoring && drives.length === 0 && !busyPhase;

  const ctaTitle =
    config?.sd_backup_mode === "auto"
      ? t("sd.drive.primaryAutoTitle")
      : t("sd.drive.primaryConfirmTitle");

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
    const detail = resolveSdEjectDetail(drive);
    try {
      await ejectSdCard(drive);
      showSdEjectToast({ drive, detail, ok: true });
      await refreshDrives();
    } catch (e) {
      showSdEjectToast({ drive, detail, ok: false, error: String(e) });
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

  const triggerTitle = (() => {
    if (busyPhase) return t("sd.drive.busyTitle");
    if (selectedInfo) {
      const tip = driveTooltip(selectedInfo);
      return t("sd.drive.pickWithTooltip", { tip });
    }
    if (drives.length === 0) {
      return watching
        ? t("sd.drive.watchingNoCard")
        : t("sd.drive.noCard");
    }
    return t("sd.drive.chooseTitle");
  })();

  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      <Select
        value={selected || undefined}
        open={open}
        disabled={controlsDisabled || drives.length === 0}
        onOpenChange={(next) => {
          if (ejecting) return;
          setOpen(next);
          if (next) {
            userPickingDriveRef.current = true;
            void refreshDrives();
          } else {
            // Defer clear so onValueChange (same pick) still sees the flag.
            window.setTimeout(() => {
              userPickingDriveRef.current = false;
            }, 0);
          }
        }}
        onValueChange={(drive) => {
          setActiveDrive(drive);
          if (userPickingDriveRef.current) {
            userPickingDriveRef.current = false;
            onOpenDrive(drive);
          }
        }}
      >
        <SelectTrigger
          className="h-8 min-w-[5.5rem] max-w-[11rem] text-xs"
          title={triggerTitle}
          aria-label={t("sd.drive.aria")}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="relative shrink-0">
              <HardDrive
                className={cn(
                  "h-3.5 w-3.5 text-primary",
                  busyPhase && "animate-pulse",
                )}
              />
              {watching && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-success"
                  title={t("sd.drive.watching")}
                  aria-hidden
                />
              )}
            </span>
            {/* Compact trigger; list items use the richer label via ItemText. */}
            {selectedInfo ? (
              <span className="truncate">
                {compactDriveLabel(selectedInfo.drive)}
              </span>
            ) : (
              <SelectValue
                placeholder={watching ? t("sd.drive.monitoring") : t("sd.drive.none")}
              />
            )}
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-[12rem]">
          {drives.map((d) => {
            const label = listDriveLabel(d);
            const volume = usefulVolumeName(d.drive, d.volume_name);
            const isEjecting = ejecting === d.drive;
            return (
              <div key={d.drive} className="relative flex items-center">
                <SelectItem
                  value={d.drive}
                  className="w-full pr-9"
                  title={driveTooltip(d)}
                >
                  <span className="flex min-w-0 max-w-[10rem] items-baseline gap-1">
                    <span className="shrink-0 not-italic">
                      {compactDriveLabel(d.drive)}
                    </span>
                    {volume && (
                      <span className="min-w-0 truncate italic">{volume}</span>
                    )}
                  </span>
                </SelectItem>
                <button
                  type="button"
                  className={cn(
                    "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted transition-colors",
                    "hover:bg-black/10 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                  title={t("sd.drive.ejectTitle", { label })}
                  aria-label={t("sd.drive.ejectAria", { label })}
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
                  <EjectIcon
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
        className="h-8 gap-1.5 px-2.5 text-xs"
        disabled={controlsDisabled || !hasDrive}
        title={ctaTitle}
        aria-label={ctaTitle}
        onClick={() => {
          if (selected) onPrimaryAction(selected);
        }}
      >
        <FolderOpen className="h-3.5 w-3.5" />
        {t("sd.drive.open")}
      </Button>
    </div>
  );
}
