import { create } from "zustand";
import { initI18n, setUiLanguage } from "@/i18n";
import { normalizeUiLanguage, type UiLanguage } from "@/i18n/types";

type LocaleState = {
  language: UiLanguage;
  ready: boolean;
  init: (initial?: string) => Promise<void>;
  setLanguage: (lang: UiLanguage) => Promise<void>;
};

export const useLocaleStore = create<LocaleState>((set) => ({
  language: "de",
  ready: false,

  init: async (initial) => {
    const lang = await initI18n(initial);
    set({ language: lang, ready: true });
  },

  setLanguage: async (lang) => {
    const normalized = normalizeUiLanguage(lang, "de");
    await setUiLanguage(normalized);
    set({ language: normalized });
  },
}));
