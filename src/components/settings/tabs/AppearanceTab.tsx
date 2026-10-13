import { useTranslation } from "react-i18next";
import { ThemePicker } from "@/components/ThemePicker";
import { useThemeStore } from "@/store/themeStore";
import { SettingsSection } from "../SettingsSection";

export function AppearanceTab() {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  return (
    <div className="space-y-3">
      <SettingsSection
        title={t("settings.general.appearance.title")}
        description={t("settings.general.appearance.description")}
      >
        <ThemePicker value={themeMode} onChange={setThemeMode} />
      </SettingsSection>
    </div>
  );
}
