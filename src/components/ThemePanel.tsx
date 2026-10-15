import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemePicker } from "@/components/ThemePicker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/store/themeStore";
import { useUiStore } from "@/store/uiStore";

/** Below AppChrome (110), above workflow; non-modal theme shelf. */
const PANEL_Z = "z-[105]";

export function ThemePanel() {
  const { t } = useTranslation();
  const panelId = useId();
  const open = useUiStore((s) => s.themePanelOpen);
  const setThemePanelOpen = useUiStore((s) => s.setThemePanelOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  useEffect(() => {
    if (!open) return;
    if (settingsOpen) {
      setThemePanelOpen(false);
      return;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setThemePanelOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, settingsOpen, setThemePanelOpen]);

  if (!open || settingsOpen) return null;

  return createPortal(
    <>
      <button
        type="button"
        className={cn(
          "fixed inset-0 cursor-default bg-black/15 dark:bg-black/25",
          PANEL_Z,
        )}
        aria-label={t("common.actions.close")}
        onClick={() => setThemePanelOpen(false)}
      />
      <aside
        id={panelId}
        data-ats-theme-panel=""
        role="dialog"
        aria-modal="false"
        aria-label={t("chrome.settings.themePanelTitle")}
        className={cn(
          "fixed bottom-0 right-0 flex w-[min(100vw,20rem)] flex-col border-l border-border bg-card shadow-xl",
          "top-11",
          PANEL_Z,
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {t("chrome.settings.themePanelTitle")}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setThemePanelOpen(false)}
            aria-label={t("common.actions.close")}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <ThemePicker
            variant="compact"
            value={themeMode}
            onChange={setThemeMode}
          />
        </div>
      </aside>
    </>,
    document.body,
  );
}
