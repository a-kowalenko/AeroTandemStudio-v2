import { Moon, Sun } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Combobox } from "@/components/ui/combobox";
import { ORT_OPTIONS } from "@/lib/tauri";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { FolderPathField } from "../FolderPathField";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function GeneralTab({ draft, patch }: SettingsTabBaseProps) {
  const showError = useUiStore((s) => s.showError);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") patch("speicherort", selected);
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Darstellung"
        description="Hell- oder Dunkelmodus der Oberfläche."
      >
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { mode: "light" as ThemeMode, label: "Hell", Icon: Sun },
              { mode: "dark" as ThemeMode, label: "Dunkel", Icon: Moon },
            ] as const
          ).map(({ mode, label, Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => setThemeMode(mode)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                themeMode === mode
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-background text-foreground hover:bg-muted/30",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Ablage"
        description="Fertige Vorgänge werden im Speicherort abgelegt."
      >
        <FolderPathField
          label="Speicherort"
          value={draft.speicherort}
          onPick={() => void pickFolder()}
          onOpenError={(message) => showError(message, "Ordner")}
        />
        <Combobox
          label="Dropzone (Standard)"
          value={draft.ort}
          onChange={(v) => patch("ort", v)}
          options={ORT_OPTIONS}
          placeholder="Dropzone…"
          listZIndex={200}
        />
      </SettingsSection>
    </div>
  );
}
