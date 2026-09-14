import { Cable, Clapperboard, HardDrive, User, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingsArea } from "@/lib/settingsUi";
import { SETTINGS_AREAS } from "@/lib/settingsUi";
import { cn } from "@/lib/utils";

const AREA_ICONS: Record<
  SettingsArea,
  typeof User
> = {
  workplace: User,
  media: HardDrive,
  connection: Cable,
  output: Clapperboard,
  maintenance: Wrench,
};

const AREA_LABEL_KEY: Record<SettingsArea, string> = {
  workplace: "settings.areas.workplace",
  media: "settings.areas.media",
  connection: "settings.areas.connection",
  output: "settings.areas.output",
  maintenance: "settings.areas.maintenance",
};

type Props = {
  value: SettingsArea;
  onChange: (area: SettingsArea) => void;
  areas?: readonly SettingsArea[];
};

export function SettingsNav({
  value,
  onChange,
  areas = SETTINGS_AREAS,
}: Props) {
  const { t } = useTranslation();

  return (
    <nav
      className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border pr-2"
      aria-label={t("settings.dialog.title")}
    >
      {areas.map((area) => {
        const Icon = AREA_ICONS[area];
        const active = area === value;
        return (
          <button
            key={area}
            type="button"
            onClick={() => onChange(area)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
              active
                ? "bg-primary-soft font-medium text-primary"
                : "text-foreground hover:bg-muted/40",
            )}
          >
            <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
            <span className="truncate">{t(AREA_LABEL_KEY[area])}</span>
          </button>
        );
      })}
    </nav>
  );
}
