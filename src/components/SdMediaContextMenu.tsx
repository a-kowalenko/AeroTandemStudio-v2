import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type SdMediaContextMenuState = {
  x: number;
  y: number;
  /** Path under the cursor (anchor for single-file actions). */
  path: string;
  /** Paths the destructive action applies to (selection or single). */
  paths: string[];
};

type Props = {
  state: SdMediaContextMenuState | null;
  onClose: () => void;
  onDelete: (paths: string[]) => void;
  disabled?: boolean;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/** Dialog shell (not `body`) so Radix `pointer-events: none` on body does not swallow hover. */
function menuPortalTarget(): HTMLElement {
  const shells = document.querySelectorAll("[data-ats-dialog-shell]");
  const last = shells[shells.length - 1];
  return last instanceof HTMLElement ? last : document.body;
}

export function SdMediaContextMenu({
  state,
  onClose,
  onDelete,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const targetPaths = state?.paths ?? [];

  useEffect(() => {
    if (!state) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onPointer(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onScroll() {
      onClose();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  useEffect(() => {
    if (!state || !ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = state.x;
    let top = state.y;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [state]);

  if (!state) return null;

  const count = Math.max(1, targetPaths.length);
  const deleteLabel =
    count === 1
      ? t("sd.selector.contextDeleteOne")
      : t("sd.selector.contextDeleteMany", { count });

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="pointer-events-auto fixed z-[120] min-w-[12.5rem] overflow-hidden rounded-md border border-border bg-card p-1 shadow-lg"
      style={{ left: state.x, top: state.y }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <p
        className="mb-1 truncate border-b border-border/60 px-2 py-1.5 text-[11px] text-muted"
        title={state.path}
      >
        {count === 1
          ? basename(state.path)
          : t("sd.selector.contextSelectionCount", { count })}
      </p>
      <MenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        disabled={disabled || targetPaths.length === 0}
        destructive
        onClick={() => {
          const paths = [...targetPaths];
          onClose();
          onDelete(paths);
        }}
      >
        {deleteLabel}
      </MenuItem>
    </div>,
    menuPortalTarget(),
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  disabled = false,
  destructive = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
        destructive
          ? "text-destructive hover:bg-destructive/20 focus-visible:bg-destructive/20"
          : "text-foreground hover:bg-muted focus-visible:bg-muted",
      )}
      onClick={onClick}
    >
      <span className={destructive ? "text-destructive" : "text-muted"}>
        {icon}
      </span>
      {children}
    </button>
  );
}

/** Open SD media context menu at cursor for `path` (single-file default). */
export function sdMediaContextMenuHandler(
  path: string,
  setMenu: (state: SdMediaContextMenuState) => void,
) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, path, paths: [path] });
  };
}
