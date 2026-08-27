import { create } from "zustand";
import type { AppConfig } from "../lib/tauri";
import { getConfig, resetConfig, saveConfig } from "../lib/tauri";
import { normalizeUiLanguage } from "../i18n/types";
import { parseLogLevelFilter } from "./logStore";

function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    crew_removed_names: Array.isArray(config.crew_removed_names)
      ? config.crew_removed_names
      : [],
    ui_language: normalizeUiLanguage(config.ui_language),
    log_min_level: parseLogLevelFilter(config.log_min_level ?? "info"),
  };
}

type ConfigState = {
  config: AppConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  updateLocal: (patch: Partial<AppConfig>) => void;
  persist: (next?: AppConfig) => Promise<AppConfig | null>;
  resetToDefaults: () => Promise<AppConfig | null>;
};

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  error: null,

  loadConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = normalizeConfig(await getConfig());
      set({ config, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  updateLocal: (patch) => {
    const current = get().config;
    if (!current) return;
    set({ config: { ...current, ...patch } });
  },

  persist: async (next) => {
    const config = next ?? get().config;
    if (!config) return null;
    set({ saving: true, error: null });
    try {
      const saved = await saveConfig(config);
      set({ config: saved, saving: false });
      return saved;
    } catch (e) {
      set({ saving: false, error: String(e) });
      return null;
    }
  },

  resetToDefaults: async () => {
    set({ saving: true, error: null });
    try {
      const config = normalizeConfig(await resetConfig());
      set({ config, saving: false });
      return config;
    } catch (e) {
      set({ saving: false, error: String(e) });
      return null;
    }
  },
}));
