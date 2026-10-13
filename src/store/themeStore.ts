import { create } from "zustand";

export type ThemeId =
  | "light"
  | "dark"
  | "team-spirit"
  | "spirit-2"
  | "royal-navy"
  | "royal-flag"
  | "rose-noir"
  | "rose-blush"
  | "military-olive"
  | "military-khaki"
  | "fsz";

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
  {
    id: "royal-navy",
    base: "dark",
    labelKey: "common.labels.themeRoyalNavy",
  },
  {
    id: "royal-flag",
    base: "dark",
    labelKey: "common.labels.themeRoyalFlag",
  },
  {
    id: "rose-noir",
    base: "dark",
    labelKey: "common.labels.themeRoseNoir",
  },
  {
    id: "rose-blush",
    base: "light",
    labelKey: "common.labels.themeRoseBlush",
  },
  {
    id: "military-olive",
    base: "dark",
    labelKey: "common.labels.themeMilitaryOlive",
  },
  {
    id: "military-khaki",
    base: "dark",
    labelKey: "common.labels.themeMilitaryKhaki",
  },
  {
    id: "fsz",
    base: "dark",
    labelKey: "common.labels.themeFsz",
  },
] as const;

const STORAGE_KEY = "ats-theme";

/** Renames from earlier Phase-55 IDs. */
const LEGACY_THEME_IDS: Record<string, ThemeId> = {
  "military-od": "military-olive",
  "military-camo": "military-khaki",
};

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
    if (!v) return null;
    if (isThemeId(v)) return v;
    const migrated = LEGACY_THEME_IDS[v];
    if (migrated) {
      try {
        localStorage.setItem(STORAGE_KEY, migrated);
      } catch {
        /* ignore */
      }
      return migrated;
    }
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
};

export const useThemeStore = create<ThemeState>((set) => ({
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
}));
