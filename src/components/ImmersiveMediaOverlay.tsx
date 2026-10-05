import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
};

/**
 * Body-portaled immersive layer (not the Fullscreen API).
 * Freezes `#root` and Radix dialogs so hit-testing works above nested dialogs
 * in the Tauri WebView — same approach as SD video tiles.
 */
export function ImmersiveMediaOverlay({
  open,
  onClose,
  ariaLabel,
  children,
  className,
}: Props) {
  useEffect(() => {
    if (!open) return;

    const frozen: { el: HTMLElement; pe: string }[] = [];
    const freeze = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return;
      if (frozen.some((f) => f.el === el)) return;
      frozen.push({ el, pe: el.style.pointerEvents });
      el.style.pointerEvents = "none";
      el.setAttribute("inert", "");
    };

    freeze(document.getElementById("root"));
    document.querySelectorAll('[role="dialog"]').forEach((node) => {
      if (
        node instanceof HTMLElement &&
        node.hasAttribute("data-immersive-overlay")
      ) {
        return;
      }
      freeze(node);
      const prev = node.previousElementSibling;
      if (prev instanceof HTMLElement && getComputedStyle(prev).position === "fixed") {
        freeze(prev);
      }
    });

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);

    return () => {
      for (const { el, pe } of frozen) {
        el.style.pointerEvents = pe;
        el.removeAttribute("inert");
      }
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={
        className ??
        "pointer-events-auto fixed inset-0 z-[9999] bg-black"
      }
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-immersive-overlay=""
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
