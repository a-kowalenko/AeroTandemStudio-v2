import { useEffect, useId, useState } from "react";
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

/** Keep in sync with `.ats-theme-panel-*` transition duration in `index.css`. */
const PANEL_ANIM_MS = 340;

export function ThemePanel() {
  const { t } = useTranslation();
  const panelId = useId();
  const open = useUiStore((s) => s.themePanelOpen);
  const setThemePanelOpen = useUiStore((s) => s.setThemePanelOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  const wantsOpen = open && !settingsOpen;
  const [present, setPresent] = useState(wantsOpen);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (settingsOpen && open) {
      setThemePanelOpen(false);
    }
  }, [settingsOpen, open, setThemePanelOpen]);

  useEffect(() => {
    if (wantsOpen) {
      setPresent(true);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(r1);
        if (r2) cancelAnimationFrame(r2);
      };
    }
    setExpanded(false);
  }, [wantsOpen]);

  useEffect(() => {
    if (wantsOpen || !present || expanded) return;
    const hideTimer = window.setTimeout(() => setPresent(false), PANEL_ANIM_MS);
    return () => window.clearTimeout(hideTimer);
  }, [wantsOpen, present, expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setThemePanelOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, setThemePanelOpen]);

  if (!present) return null;

  return createPortal(
    <div
      className={cn("ats-theme-panel-root fixed inset-0", PANEL_Z)}
      data-open={expanded ? "true" : "false"}
      aria-hidden={!expanded}
    >
      <button
        type="button"
        className="ats-theme-panel-dismiss fixed bottom-0 left-0 top-11 right-[min(100vw,20rem)] cursor-default border-0"
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
          "ats-theme-panel-shell fixed bottom-0 right-0 top-11 flex w-[min(100vw,20rem)] flex-col border-l border-border bg-card shadow-xl",
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
    </div>,
    document.body,
  );
}
