import { create } from "zustand";

export type ThemeId = "light" | "dark" | "team-spirit" | "spirit-2";

/** @deprecated Prefer ThemeId — kept for gradual call-site updates. */
export type ThemeMode = ThemeId;

export type ThemeBase = "light" | "dark";

export type ThemeMeta = {
  id: ThemeId;
  base: ThemeBase;
  labelKey: string;
};

export const THEMES: readonly ThemeMeta[] = [
  { id: "light", base: "light", labelKey: "common.labels.themeLight" },
  { id: "dark", base: "dark", labelKey: "common.labels.themeDark" },
  {
    id: "team-spirit",
    base: "dark",
    labelKey: "common.labels.themeTeamSpirit",
  },
  {
    id: "spirit-2",
    base: "dark",
    labelKey: "common.labels.themeSpirit2",
  },
] as const;

const STORAGE_KEY = "ats-theme";

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

export function isThemeId(v: string): v is ThemeId {
  return THEME_IDS.has(v);
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

function readStored(): ThemeId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && isThemeId(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

export function applyDom(id: ThemeId) {
  const meta = themeMeta(id);
  document.documentElement.classList.toggle("dark", meta.base === "dark");
  document.documentElement.dataset.theme = id;
}

export function initTheme(): ThemeId {
  const stored = readStored();
  const id = stored ?? (systemPrefersDark() ? "dark" : "light");
  applyDom(id);
  return id;
}

type ThemeState = {
  mode: ThemeId;
  setMode: (mode: ThemeId) => void;
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
    const idx = THEMES.findIndex((t) => t.id === get().mode);
    const next = THEMES[(idx + 1) % THEMES.length] ?? THEMES[0];
    get().setMode(next.id);
  },
}));
