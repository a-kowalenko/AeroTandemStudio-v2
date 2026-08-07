import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfigStore } from "../store/configStore";
import { cn } from "../lib/utils";

const MODE_OPTIONS = [
  { key: "auto", label: "Auto", tip: "SD-Karte wird bei Einstecken automatisch gesichert." },
  {
    key: "confirm",
    label: "Vorher bestätigen",
    tip: "Vor dem Backup erscheint ein Bestätigungsdialog.",
  },
  {
    key: "disabled",
    label: "Deaktiviert",
    tip: "SD wird erkannt, aber nicht automatisch gesichert.",
  },
] as const;

type Props = {
  className?: string;
  visible?: boolean;
};

export function SdModeSelector({ className, visible = true }: Props) {
  const config = useConfigStore((s) => s.config);
  const updateLocal = useConfigStore((s) => s.updateLocal);
  const persist = useConfigStore((s) => s.persist);

  if (!visible || !config) return null;

  const mode = MODE_OPTIONS.some((m) => m.key === config.sd_backup_mode)
    ? config.sd_backup_mode
    : "confirm";
  const tip = MODE_OPTIONS.find((m) => m.key === mode)?.tip;

  return (
    <div className={cn("flex items-center gap-2 text-xs", className)} title={tip}>
      <span className="text-muted">Backup:</span>
      <Select
        value={mode}
        onValueChange={(v) => {
          updateLocal({ sd_backup_mode: v });
          void persist({ ...config, sd_backup_mode: v });
        }}
      >
        <SelectTrigger className="h-8 w-[160px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((m) => (
            <SelectItem key={m.key} value={m.key}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
