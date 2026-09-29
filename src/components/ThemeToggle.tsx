import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/store/themeStore";

type Props = {
  className?: string;
};

export function ThemeToggle({ className }: Props) {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => s.mode);
  const toggle = useThemeStore((s) => s.toggle);
  const isDark = mode === "dark";
  const label = isDark
    ? t("common.labels.themeLight")
    : t("common.labels.themeDark");

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
      {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </Button>
  );
}
