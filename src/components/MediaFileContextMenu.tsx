import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, FolderOpen, ExternalLink, Pencil, QrCode, RotateCcw, Trash2 } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";

export type MediaContextMenuState = {
  x: number;
  y: number;
  path: string;
};

type Props = {
  state: MediaContextMenuState | null;
  onClose: () => void;
  onError?: (message: string) => void;
  onCopied?: () => void;
  /** Optional: scan QR for this file */
  onScanQr?: (path: string) => void;
  /** Optional: open edit dialog for this video/photo */
  onCut?: (path: string) => void;
  /** Optional: undo trim/split/rotate for this clip (shown when `canUndoCut`) */
  onUndoCut?: (path: string) => void;
  /** Show undo-edit item (clip/photo was edited) */
  canUndoCut?: boolean;
  /** Optional: remove this file from the session list */
  onRemove?: (path: string) => void;
  /** Disable QR / remove while busy */
  actionsDisabled?: boolean;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/** Reveal file in OS file manager (Explorer / Finder). */
export async function revealMediaInFolder(path: string): Promise<void> {
  await revealItemInDir(path);
}

export function MediaFileContextMenu({
  state,
  onClose,
  onError,
  onCopied,
  onScanQr,
  onCut,
  onUndoCut,
  canUndoCut = false,
  onRemove,
  actionsDisabled = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

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

  async function reveal() {
    try {
      await revealItemInDir(state!.path);
      onClose();
    } catch (e) {
      onError?.(String(e));
      onClose();
    }
  }

  async function openFile() {
    try {
      await openPath(state!.path);
      onClose();
    } catch (e) {
      onError?.(String(e));
      onClose();
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(state!.path);
      onCopied?.();
      onClose();
    } catch (e) {
      onError?.(String(e));
      onClose();
    }
  }

  const showClipActions = Boolean(onScanQr || onCut || (canUndoCut && onUndoCut));
  const showExtra = Boolean(showClipActions || onRemove);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={cn(
        "fixed z-[80] min-w-[12.5rem] overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg",
      )}
      style={{ left: state.x, top: state.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p
        className="truncate border-b border-border/60 px-3 py-1.5 text-[11px] text-muted"
        title={state.path}
      >
        {basename(state.path)}
      </p>
      <MenuItem icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void openFile()}>
        Öffnen
      </MenuItem>
      <MenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => void reveal()}>
        Im Ordner zeigen
      </MenuItem>
      <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyPath()}>
        Pfad kopieren
      </MenuItem>
      {showExtra && <div className="my-1 border-t border-border/60" role="separator" />}
      {onScanQr && (
        <MenuItem
          icon={<QrCode className="h-3.5 w-3.5" />}
          disabled={actionsDisabled}
          onClick={() => {
            const path = state.path;
            onClose();
            onScanQr(path);
          }}
        >
          QR scannen
        </MenuItem>
      )}
      {onCut && (
        <MenuItem
          icon={<Pencil className="h-3.5 w-3.5" />}
          disabled={actionsDisabled}
          onClick={() => {
            const path = state.path;
            onClose();
            onCut(path);
          }}
        >
          Bearbeiten
        </MenuItem>
      )}
      {canUndoCut && onUndoCut && (
        <MenuItem
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          disabled={actionsDisabled}
          onClick={() => {
            const path = state.path;
            onClose();
            onUndoCut(path);
          }}
        >
          Bearbeitung rückgängig
        </MenuItem>
      )}
      {showClipActions && onRemove && (
        <div className="my-1 border-t border-border/60" role="separator" />
      )}
      {onRemove && (
        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          disabled={actionsDisabled}
          destructive
          onClick={() => {
            const path = state.path;
            onClose();
            onRemove(path);
          }}
        >
          Entfernen
        </MenuItem>
      )}
    </div>,
    document.body,
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
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-50",
        destructive ? "text-destructive" : "text-foreground",
      )}
      onClick={onClick}
    >
      <span className={destructive ? "text-destructive" : "text-muted"}>{icon}</span>
      {children}
    </button>
  );
}

/** Attach to a row/clip: open context menu at cursor for `path`. */
export function mediaContextMenuHandler(
  path: string,
  setMenu: (state: MediaContextMenuState) => void,
) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, path });
  };
}
