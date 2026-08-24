import type { UiLanguage } from "@/i18n/types";

/** Native language names — not translated when the UI language changes. */
export const UI_LANGUAGE_OPTIONS: { value: UiLanguage; label: string }[] = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
  { value: "es-MX", label: "Español (México)" },
];

export function uiLanguageLabel(lang: UiLanguage | string | undefined): string {
  return UI_LANGUAGE_OPTIONS.find((o) => o.value === lang)?.label ?? String(lang ?? "");
}
