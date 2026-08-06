import { create } from "zustand";
import type { AppConfig } from "../lib/tauri";
import { getConfig, saveConfig } from "../lib/tauri";

type ConfigState = {
  config: AppConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  updateLocal: (patch: Partial<AppConfig>) => void;
  persist: (next?: AppConfig) => Promise<AppConfig | null>;
};

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  error: null,

  loadConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await getConfig();
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
}));
