import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  THEME_GROUPS,
  THEME_HINT_KEYS,
  THEME_SWATCHES,
  themesInGroup,
} from "@/lib/themeCatalog";
import { cn } from "@/lib/utils";
import { themeMeta, type ThemeId } from "@/store/themeStore";

type Props = {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
  className?: string;
};

function ThemeSwatchPreview({
  themeId,
  selected,
}: {
  themeId: ThemeId;
  selected: boolean;
}) {
  const s = THEME_SWATCHES[themeId];
  const checkOnDark = themeMeta(themeId).base === "dark";

  return (
    <div
      className="relative mb-2 h-14 overflow-hidden rounded-md ring-1 ring-black/10 dark:ring-white/10"
      style={{ background: s.bg }}
      aria-hidden
    >
      {/* Mini header strip */}
      <div
        className="absolute inset-x-0 top-0 h-3.5 border-b"
        style={{
          background: s.surface,
          borderColor: "color-mix(in srgb, " + s.primary + " 22%, transparent)",
        }}
      >
        <div
          className="absolute left-1.5 top-1 h-1.5 w-1.5 rounded-sm"
          style={{ background: s.primary }}
        />
        <div
          className="absolute left-4 top-1.5 h-1 w-6 rounded-full opacity-50"
          style={{ background: s.accent }}
        />
      </div>
      {/* Color dots */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1">
        <span
          className="h-2.5 w-2.5 rounded-full shadow-sm ring-1 ring-black/15"
          style={{ background: s.primary }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full shadow-sm ring-1 ring-black/15"
          style={{ background: s.accent }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full shadow-sm ring-1 ring-black/15"
          style={{ background: s.surface }}
        />
      </div>
      {selected ? (
        <span
          className={cn(
            "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-sm",
            checkOnDark ? "bg-white text-black" : "bg-black/80 text-white",
          )}
        >
          <Check className="h-3 w-3" strokeWidth={2.5} />
        </span>
      ) : null}
    </div>
  );
}

export function ThemePicker({ value, onChange, className }: Props) {
  const { t } = useTranslation();

  return (
    <div className={cn("space-y-4", className)}>
      {THEME_GROUPS.map((group) => (
        <div key={group.id} className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t(group.labelKey)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {themesInGroup(group).map(({ id, labelKey }) => {
              const selected = value === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChange(id)}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-xl border p-2.5 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary-soft shadow-[0_0_0_1px_var(--ats-primary)]"
                      : "border-border bg-background hover:bg-muted/30",
                  )}
                >
                  <ThemeSwatchPreview themeId={id} selected={selected} />
                  <div className="min-w-0 px-0.5">
                    <div
                      className={cn(
                        "truncate text-sm font-medium",
                        selected ? "text-primary" : "text-foreground",
                      )}
                    >
                      {t(labelKey)}
                    </div>
                    <div className="truncate text-[11px] text-muted">
                      {t(THEME_HINT_KEYS[id])}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
