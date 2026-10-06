import { useEffect } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  return el != null;
}

/**
 * In production builds, suppress the WebView/browser context menu so the app
 * feels native. Dev keeps the default menu (Inspect, Reload, …).
 * Custom React menus still work — they call preventDefault themselves and we
 * never stopPropagation here. Editable fields keep the native menu for copy/paste.
 */
export function usePreventDefaultContextMenu() {
  useEffect(() => {
    if (!import.meta.env.PROD) return;

    function onContextMenu(e: Event) {
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
    }

    document.addEventListener("contextmenu", onContextMenu, { capture: true });
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, { capture: true });
    };
  }, []);
}
