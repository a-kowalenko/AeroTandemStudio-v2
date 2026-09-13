import { cn } from "@/lib/utils";
import type { SettingsUiMode } from "@/lib/settingsUi";

type Props = {
  value: SettingsUiMode;
  onChange: (mode: SettingsUiMode) => void;
  simpleLabel: string;
  advancedLabel: string;
};

export function ComplexityToggle({
  value,
  onChange,
  simpleLabel,
  advancedLabel,
}: Props) {
  return (
    <div
      className="inline-flex rounded-lg border border-border p-0.5 text-xs"
      role="group"
    >
      {(
        [
          { mode: "simple" as const, label: simpleLabel },
          { mode: "advanced" as const, label: advancedLabel },
        ] as const
      ).map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium transition-colors",
            value === mode
              ? "bg-primary-soft text-primary"
              : "text-muted hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
