import { create } from "zustand";

export type ThemeId =
  | "light"
  | "dark"
  | "team-spirit"
  | "deutschland"
  | "deutschland-dark"
  | "spirit-2"
  | "royal-navy"
  | "royal-flag"
  | "rose-noir"
  | "rose-blush"
  | "military-olive"
  | "military-khaki"
  | "desert"
  | "lavender"
  | "neon"
  | "petal"
  | "harbor"
  | "ember"
  | "sky-horizon"
  | "sky-dusk"
  | "sunset"
  | "graphite"
  | "prussian-day"
  | "prussian-night"
  | "arctic"
  | "forest"
  | "fsz"
  | "fsz-light";

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
    id: "spirit-2",
    base: "dark",
    labelKey: "common.labels.themeSpirit2",
  },
  {
    id: "team-spirit",
    base: "dark",
    labelKey: "common.labels.themeTeamSpirit",
  },
  {
    id: "deutschland",
    base: "light",
    labelKey: "common.labels.themeDeutschland",
  },
  {
    id: "deutschland-dark",
    base: "dark",
    labelKey: "common.labels.themeDeutschlandDark",
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
    id: "rose-blush",
    base: "light",
    labelKey: "common.labels.themeRoseBlush",
  },
  {
    id: "rose-noir",
    base: "dark",
    labelKey: "common.labels.themeRoseNoir",
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
    id: "desert",
    base: "light",
    labelKey: "common.labels.themeDesert",
  },
  {
    id: "lavender",
    base: "light",
    labelKey: "common.labels.themeLavender",
  },
  {
    id: "neon",
    base: "dark",
    labelKey: "common.labels.themeNeon",
  },
  {
    id: "petal",
    base: "light",
    labelKey: "common.labels.themePetal",
  },
  {
    id: "harbor",
    base: "light",
    labelKey: "common.labels.themeHarbor",
  },
  {
    id: "ember",
    base: "dark",
    labelKey: "common.labels.themeEmber",
  },
  {
    id: "sky-horizon",
    base: "light",
    labelKey: "common.labels.themeSkyHorizon",
  },
  {
    id: "sky-dusk",
    base: "dark",
    labelKey: "common.labels.themeSkyDusk",
  },
  {
    id: "sunset",
    base: "dark",
    labelKey: "common.labels.themeSunset",
  },
  {
    id: "arctic",
    base: "light",
    labelKey: "common.labels.themeArctic",
  },
  {
    id: "forest",
    base: "dark",
    labelKey: "common.labels.themeForest",
  },
  {
    id: "graphite",
    base: "dark",
    labelKey: "common.labels.themeGraphite",
  },
  {
    id: "prussian-day",
    base: "light",
    labelKey: "common.labels.themePrussianDay",
  },
  {
    id: "prussian-night",
    base: "dark",
    labelKey: "common.labels.themePrussianNight",
  },
  {
    id: "fsz-light",
    base: "light",
    labelKey: "common.labels.themeFszLight",
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
  "ember-2": "ember",
  prussian: "prussian-night",
  "team-spirit-light": "deutschland",
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

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  );
}

type ViewTransitionHandle = { finished?: Promise<void> };

function startThemeViewTransition(update: () => void) {
  const root = document.getElementById("root");
  const rootStart = root
    ? (root as HTMLElement & {
        startViewTransition?: (updateCallback: () => void) => ViewTransitionHandle;
      }).startViewTransition
    : undefined;

  // Scoped to #root — ambient mark stays live on body::before (not in snapshots).
  if (rootStart) {
    rootStart.call(root, update);
    return;
  }

  // Document-level VT captures the full page and flashes the ambient mark on top.
  update();
}

/** User-initiated theme changes; instant when View Transitions or motion prefs unavailable. */
export function applyDomWithTransition(id: ThemeId) {
  const run = () => applyDom(id);
  if (prefersReducedMotion()) {
    run();
    return;
  }
  startThemeViewTransition(run);
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

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "light",
  setMode: (mode) => {
    if (get().mode === mode) return;
    applyDomWithTransition(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    set({ mode });
  },
}));
