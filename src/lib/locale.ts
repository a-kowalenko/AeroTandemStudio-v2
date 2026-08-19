import i18n from "@/i18n";
import { intlLocaleFor, type UiLanguage } from "@/i18n/types";

export function activeUiLanguage(): UiLanguage {
  const lang = i18n.language;
  if (lang === "en" || lang === "es-MX" || lang === "de") return lang;
  return "de";
}

export function activeIntlLocale(): string {
  return intlLocaleFor(activeUiLanguage());
}

export function formatLocaleDateTime(value: Date | number): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return d.toLocaleString(activeIntlLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatLocaleDate(value: Date | number): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return d.toLocaleDateString(activeIntlLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function localeCompareStrings(a: string, b: string): number {
  return a.localeCompare(b, activeIntlLocale(), { sensitivity: "base" });
}
