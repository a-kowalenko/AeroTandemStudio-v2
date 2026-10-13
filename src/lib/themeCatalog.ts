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
    themeIds: ["spirit-2", "team-spirit", "fsz-light", "fsz"],
  },
  {
    id: "looks",
    labelKey: "settings.general.appearance.groups.looks",
    themeIds: [
      "royal-navy",
      "royal-flag",
      "rose-blush",
      "rose-noir",
      "military-olive",
      "military-khaki",
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
    primary: "#f0e6e8",
    accent: "#e8b8c4",
  },
  "rose-blush": {
    bg: "#fdf5f7",
    surface: "#fffafb",
    primary: "#a84d6a",
    accent: "#e8a0b0",
  },
  "military-olive": {
    bg: "#161a12",
    surface: "#22281a",
    primary: "#7a8f3e",
    accent: "#a8b86a",
  },
  "military-khaki": {
    bg: "#1a1812",
    surface: "#28241a",
    primary: "#c4a35a",
    accent: "#dcc896",
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
  "spirit-2": "settings.general.appearance.hints.spirit2",
  "royal-navy": "settings.general.appearance.hints.royalNavy",
  "royal-flag": "settings.general.appearance.hints.royalFlag",
  "rose-noir": "settings.general.appearance.hints.roseNoir",
  "rose-blush": "settings.general.appearance.hints.roseBlush",
  "military-olive": "settings.general.appearance.hints.militaryOlive",
  "military-khaki": "settings.general.appearance.hints.militaryKhaki",
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
