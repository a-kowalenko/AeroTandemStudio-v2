import { useTranslation } from "react-i18next";
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
  {
    key: "auto",
    labelKey: "settings.sd.backup.modeAuto",
    tipKey: "sd.mode.autoTip",
  },
  {
    key: "confirm",
    labelKey: "settings.sd.backup.modeConfirm",
    tipKey: "sd.mode.confirmTip",
  },
  {
    key: "disabled",
    labelKey: "settings.sd.backup.modeDisabled",
    tipKey: "sd.mode.disabledTip",
  },
] as const;

type Props = {
  className?: string;
  visible?: boolean;
  disabled?: boolean;
};

export function SdModeSelector({
  className,
  visible = true,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const updateLocal = useConfigStore((s) => s.updateLocal);
  const persist = useConfigStore((s) => s.persist);

  if (!visible || !config) return null;

  const mode = MODE_OPTIONS.some((m) => m.key === config.sd_backup_mode)
    ? config.sd_backup_mode
    : "confirm";
  const selectedMode = MODE_OPTIONS.find((m) => m.key === mode);
  const tip = selectedMode ? t(selectedMode.tipKey) : undefined;

  return (
    <div className={cn("flex items-center gap-2 text-xs", className)} title={tip}>
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(v) => {
          updateLocal({ sd_backup_mode: v });
          void persist({ ...config, sd_backup_mode: v });
        }}
      >
        <SelectTrigger
          className="h-8 w-[160px] text-xs"
          aria-label={t("settings.sd.backup.mode")}
          title={tip}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((m) => (
            <SelectItem key={m.key} value={m.key}>
              {t(m.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
