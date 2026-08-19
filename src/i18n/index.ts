import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "@/locales/de.json";
import en from "@/locales/en.json";
import esMX from "@/locales/es-MX.json";
import {
  detectSystemUiLanguage,
  normalizeUiLanguage,
  type UiLanguage,
} from "@/i18n/types";

export { i18n };

export function applyDocumentLanguage(lang: UiLanguage): void {
  document.documentElement.lang = lang;
}

export async function initI18n(initialLanguage?: string): Promise<UiLanguage> {
  const lang = normalizeUiLanguage(
    initialLanguage?.trim() || detectSystemUiLanguage(),
    "de",
  );

  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: {
        de: { translation: de },
        en: { translation: en },
        "es-MX": { translation: esMX },
      },
      lng: lang,
      fallbackLng: "de",
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else if (i18n.language !== lang) {
    await i18n.changeLanguage(lang);
  }

  applyDocumentLanguage(lang);
  return lang;
}

export async function setUiLanguage(lang: UiLanguage): Promise<void> {
  await i18n.changeLanguage(lang);
  applyDocumentLanguage(lang);
}

/** Translate outside React (lib mappers, stores). */
export function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export default i18n;
