import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "@/locales/de.json";
import {
  detectSystemUiLanguage,
  normalizeUiLanguage,
  type UiLanguage,
} from "@/i18n/types";

export { i18n };

type LocaleResource = Record<string, unknown>;

/** `de` is bundled (default + fallback); other locales are separate chunks. */
const lazyLocales: Partial<Record<UiLanguage, () => Promise<{ default: LocaleResource }>>> = {
  en: () => import("@/locales/en.json"),
  "es-MX": () => import("@/locales/es-MX.json"),
};

const loadedLocales = new Set<UiLanguage>(["de"]);

async function loadLocaleResource(lang: UiLanguage): Promise<LocaleResource | null> {
  if (loadedLocales.has(lang)) return null;
  const loader = lazyLocales[lang];
  if (!loader) return null;
  const mod = await loader();
  loadedLocales.add(lang);
  return mod.default;
}

/** Ensure `lang` is registered with i18next (no-op once loaded). */
async function ensureLocale(lang: UiLanguage): Promise<UiLanguage> {
  try {
    const res = await loadLocaleResource(lang);
    if (res && i18n.isInitialized) {
      i18n.addResourceBundle(lang, "translation", res, true, true);
    }
    return lang;
  } catch (e) {
    console.warn(`locale ${lang} failed to load; falling back to de`, e);
    return "de";
  }
}

/** Read by the inline boot-splash script in `index.html` — keep the key in sync. */
const UI_LANGUAGE_STORAGE_KEY = "ats-lang";

function storedUiLanguage(): string | null {
  try {
    return localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistUiLanguage(lang: UiLanguage): void {
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
}

export function applyDocumentLanguage(lang: UiLanguage): void {
  document.documentElement.lang = lang;
}

export async function initI18n(initialLanguage?: string): Promise<UiLanguage> {
  const requested = normalizeUiLanguage(
    initialLanguage?.trim() || storedUiLanguage() || detectSystemUiLanguage(),
    "de",
  );

  let lang: UiLanguage = requested;
  if (!i18n.isInitialized) {
    let extra: LocaleResource | null = null;
    try {
      extra = await loadLocaleResource(requested);
    } catch (e) {
      console.warn(`locale ${requested} failed to load; falling back to de`, e);
      lang = "de";
    }
    await i18n.use(initReactI18next).init({
      resources: {
        de: { translation: de },
        ...(extra ? { [requested]: { translation: extra } } : {}),
      },
      lng: lang,
      fallbackLng: "de",
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else {
    lang = await ensureLocale(requested);
    if (i18n.language !== lang) await i18n.changeLanguage(lang);
  }

  applyDocumentLanguage(lang);
  return lang;
}

export async function setUiLanguage(lang: UiLanguage): Promise<UiLanguage> {
  const effective = await ensureLocale(lang);
  await i18n.changeLanguage(effective);
  applyDocumentLanguage(effective);
  persistUiLanguage(effective);
  return effective;
}

/** Translate outside React (lib mappers, stores). */
export function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export default i18n;
