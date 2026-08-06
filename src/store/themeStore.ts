import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "ats-theme";

function readStored(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return null;
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function applyDom(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = mode;
}

export function initTheme(): ThemeMode {
  const stored = readStored();
  const mode = stored ?? (systemPrefersDark() ? "dark" : "light");
  applyDom(mode);
  return mode;
}

type ThemeState = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "light",
  setMode: (mode) => {
    applyDom(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    set({ mode });
  },
  toggle: () => {
    const next: ThemeMode = get().mode === "light" ? "dark" : "light";
    get().setMode(next);
  },
}));
