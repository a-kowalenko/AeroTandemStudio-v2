import type { ThemeId } from "@/store/themeStore";

const DEFAULT_LOGO = "/logo.png";
/** Vector mark — also used as ambient corner bleed in `index.css`. */
const TEAM_SPIRIT_LOGO = "/themes/team-spirit/logo.svg";
const FSZ_LOGO = "/themes/fsz/logo.png";

/** Header / splash logo path for the active UI theme. Favicon stays ATS. */
export function resolveThemeLogo(themeId: ThemeId): string {
  if (themeId === "team-spirit" || themeId === "spirit-2") {
    return TEAM_SPIRIT_LOGO;
  }
  if (themeId === "fsz") {
    return FSZ_LOGO;
  }
  return DEFAULT_LOGO;
}
