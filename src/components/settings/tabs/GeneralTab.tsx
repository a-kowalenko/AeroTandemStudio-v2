import { Languages, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_LANGUAGES, type UiLanguage } from "@/i18n/types";
import { UI_LANGUAGE_OPTIONS } from "@/lib/uiLanguageOptions";
import { useLocaleStore } from "@/store/localeStore";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function GeneralTab({ draft, patchNow }: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const setLanguage = useLocaleStore((s) => s.setLanguage);

  async function onLanguageChange(lang: string) {
    if (!UI_LANGUAGES.includes(lang as UiLanguage)) return;
    const uiLang = lang as UiLanguage;
    patchNow("ui_language", uiLang);
    await setLanguage(uiLang);
  }

  return (
    <div className="space-y-3">
      <SettingsSection title={t("common.labels.language")}>
        <div className="grid grid-cols-3 gap-2">
          {UI_LANGUAGE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => void onLanguageChange(value)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-sm transition-colors",
                draft.ui_language === value
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-background text-foreground hover:bg-muted/30",
              )}
            >
              <Languages className="h-4 w-4 shrink-0 opacity-70" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.general.appearance.title")}>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { mode: "light" as ThemeMode, labelKey: "common.labels.themeLight", Icon: Sun },
              { mode: "dark" as ThemeMode, labelKey: "common.labels.themeDark", Icon: Moon },
            ] as const
          ).map(({ mode, labelKey, Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => setThemeMode(mode)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                themeMode === mode
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-background text-foreground hover:bg-muted/30",
              )}
            >
              <Icon className="h-4 w-4" />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
