import { THEMES, themeMeta, type ThemeId } from "@/store/themeStore";

export type ThemeGroupId = "base" | "specials" | "looks";

export type ThemeGroup = {
  id: ThemeGroupId;
  labelKey: string;
  themeIds: readonly ThemeId[];
};

/** Picker sections — order is display order. */
export const THEME_GROUPS: readonly ThemeGroup[] = [
  {
    id: "base",
    labelKey: "settings.general.appearance.groups.base",
    themeIds: ["light", "dark"],
  },
  {
    id: "specials",
    labelKey: "settings.general.appearance.groups.specials",
    themeIds: [
      "spirit-2",
      "team-spirit",
      "deutschland",
      "deutschland-dark",
      "fsz-light",
      "fsz",
    ],
  },
  {
    id: "looks",
    labelKey: "settings.general.appearance.groups.looks",
    themeIds: [
      "sky-horizon",
      "sky-dusk",
      "arctic",
      "graphite",
      "prussian-day",
      "prussian-night",
      "sunset",
      "forest",
      "royal-navy",
      "royal-flag",
      "rose-blush",
      "rose-noir",
      "lavender",
      "military-olive",
      "desert",
      "military-khaki",
      "petal",
      "neon",
      "harbor",
      "ember",
    ],
  },
] as const;

/** Mini preview chips — mirrors `index.css` theme tokens. */
export type ThemeSwatch = {
  bg: string;
  surface: string;
  primary: string;
  accent: string;
};

export const THEME_SWATCHES: Record<ThemeId, ThemeSwatch> = {
  light: {
    bg: "#eef4f2",
    surface: "#ffffff",
    primary: "#009d8b",
    accent: "#0d7a6c",
  },
  dark: {
    bg: "#0c1210",
    surface: "#151c19",
    primary: "#1ab5a0",
    accent: "#3dceb8",
  },
  "team-spirit": {
    bg: "#0a0a0a",
    surface: "#1a1a1a",
    primary: "#b59546",
    accent: "#c9a84c",
  },
  deutschland: {
    bg: "#eceef1",
    surface: "#ffffff",
    primary: "#1a1d21",
    accent: "#c8982e",
  },
  "deutschland-dark": {
    bg: "#121418",
    surface: "#1e2228",
    primary: "#f2f3f5",
    accent: "#ffcc00",
  },
  "spirit-2": {
    bg: "#080808",
    surface: "#26261f",
    primary: "#d0b056",
    accent: "#dfc36a",
  },
  "royal-navy": {
    bg: "#0a1220",
    surface: "#121c2e",
    primary: "#3b6ae8",
    accent: "#e8eef8",
  },
  "royal-flag": {
    bg: "#0c1830",
    surface: "#152648",
    primary: "#2f5bff",
    accent: "#f5f8ff",
  },
  "rose-noir": {
    bg: "#100e10",
    surface: "#1a1618",
    primary: "#e87898",
    accent: "#f8b0c4",
  },
  "rose-blush": {
    bg: "#fdf5f7",
    surface: "#fffafb",
    primary: "#a84d6a",
    accent: "#e8a0b0",
  },
  lavender: {
    bg: "#f4eeff",
    surface: "#fffcff",
    primary: "#424874",
    accent: "#a6b1e1",
  },
  "military-olive": {
    bg: "#161a12",
    surface: "#22281a",
    primary: "#7a8f3e",
    accent: "#a8b86a",
  },
  "military-khaki": {
    bg: "#322a1e",
    surface: "#403628",
    primary: "#d6b86e",
    accent: "#ead6a4",
  },
  desert: {
    bg: "#f5ebda",
    surface: "#fffbf4",
    primary: "#c4782a",
    accent: "#e0b86a",
  },
  neon: {
    bg: "#252a34",
    surface: "#2e3544",
    primary: "#08d9d6",
    accent: "#ff2e63",
  },
  petal: {
    bg: "#ece2e1",
    surface: "#fffbfa",
    primary: "#2f7578",
    accent: "#aee1e1",
  },
  harbor: {
    bg: "#f5efe6",
    surface: "#fffdf8",
    primary: "#3f6280",
    accent: "#7895b2",
  },
  ember: {
    bg: "#30475e",
    surface: "#222831",
    primary: "#f05454",
    accent: "#8e1e28",
  },
  "sky-horizon": {
    bg: "#e8f2fa",
    surface: "#ffffff",
    primary: "#2b7fd4",
    accent: "#7eb8e8",
  },
  "sky-dusk": {
    bg: "#0a1628",
    surface: "#142438",
    primary: "#4a9ef0",
    accent: "#8eb8e0",
  },
  sunset: {
    bg: "#1a1210",
    surface: "#2a1c16",
    primary: "#e07830",
    accent: "#f0a060",
  },
  arctic: {
    bg: "#f2f5f8",
    surface: "#ffffff",
    primary: "#3d6a8a",
    accent: "#a8c4d8",
  },
  forest: {
    bg: "#0e1610",
    surface: "#1a2820",
    primary: "#2d8a5a",
    accent: "#5ab884",
  },
  graphite: {
    bg: "#121214",
    surface: "#1c1c20",
    primary: "#a8aab0",
    accent: "#c8cad0",
  },
  "prussian-day": {
    bg: "#e5e5e5",
    surface: "#ffffff",
    primary: "#fca311",
    accent: "#14213d",
  },
  "prussian-night": {
    bg: "#000000",
    surface: "#14213d",
    primary: "#fca311",
    accent: "#e5e5e5",
  },
  fsz: {
    bg: "#141012",
    surface: "#2e2628",
    primary: "#f0ecec",
    accent: "#a40c20",
  },
  "fsz-light": {
    bg: "#f0eeee",
    surface: "#f7f5f5",
    primary: "#141414",
    accent: "#a40c20",
  },
};

export const THEME_HINT_KEYS: Record<ThemeId, string> = {
  light: "settings.general.appearance.hints.light",
  dark: "settings.general.appearance.hints.dark",
  "team-spirit": "settings.general.appearance.hints.teamSpirit",
  deutschland: "settings.general.appearance.hints.deutschland",
  "deutschland-dark": "settings.general.appearance.hints.deutschlandDark",
  "spirit-2": "settings.general.appearance.hints.spirit2",
  "royal-navy": "settings.general.appearance.hints.royalNavy",
  "royal-flag": "settings.general.appearance.hints.royalFlag",
  "rose-noir": "settings.general.appearance.hints.roseNoir",
  "rose-blush": "settings.general.appearance.hints.roseBlush",
  lavender: "settings.general.appearance.hints.lavender",
  "military-olive": "settings.general.appearance.hints.militaryOlive",
  "military-khaki": "settings.general.appearance.hints.militaryKhaki",
  desert: "settings.general.appearance.hints.desert",
  neon: "settings.general.appearance.hints.neon",
  petal: "settings.general.appearance.hints.petal",
  harbor: "settings.general.appearance.hints.harbor",
  ember: "settings.general.appearance.hints.ember",
  "sky-horizon": "settings.general.appearance.hints.skyHorizon",
  "sky-dusk": "settings.general.appearance.hints.skyDusk",
  sunset: "settings.general.appearance.hints.sunset",
  arctic: "settings.general.appearance.hints.arctic",
  forest: "settings.general.appearance.hints.forest",
  graphite: "settings.general.appearance.hints.graphite",
  "prussian-day": "settings.general.appearance.hints.prussianDay",
  "prussian-night": "settings.general.appearance.hints.prussianNight",
  fsz: "settings.general.appearance.hints.fsz",
  "fsz-light": "settings.general.appearance.hints.fszLight",
};

export function themesInGroup(group: ThemeGroup) {
  return group.themeIds.map((id) => themeMeta(id));
}

/** Dev-time sanity: every THEMES id appears in exactly one group. */
export function assertThemeCatalogCoverage(): void {
  const seen = new Set<ThemeId>();
  for (const g of THEME_GROUPS) {
    for (const id of g.themeIds) {
      if (seen.has(id)) throw new Error(`theme ${id} in multiple groups`);
      seen.add(id);
    }
  }
  for (const t of THEMES) {
    if (!seen.has(t.id)) throw new Error(`theme ${t.id} missing from groups`);
  }
}
