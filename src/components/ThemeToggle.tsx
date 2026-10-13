import { Moon, Sparkles, Star, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { THEMES, themeMeta, useThemeStore, type ThemeId } from "@/store/themeStore";

type Props = {
  className?: string;
};

function ThemeIcon({ id }: { id: ThemeId }) {
  const className = "h-3.5 w-3.5";
  if (id === "light") return <Sun className={className} />;
  if (id === "team-spirit") return <Sparkles className={className} />;
  if (id === "spirit-2") return <Star className={className} />;
  return <Moon className={className} />;
}

/** Label for the *next* theme in the cycle (what the click will apply). */
function nextThemeId(current: ThemeId): ThemeId {
  const idx = THEMES.findIndex((t) => t.id === current);
  return THEMES[(idx + 1) % THEMES.length]?.id ?? "light";
}

export function ThemeToggle({ className }: Props) {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => s.mode);
  const toggle = useThemeStore((s) => s.toggle);
  const next = nextThemeId(mode);
  const label = t(themeMeta(next).labelKey);

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className={className}
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      <ThemeIcon id={mode} />
    </Button>
  );
}
