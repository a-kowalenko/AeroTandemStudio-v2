import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TitleBarControls } from "./TitleBarControls";
import { useWindowChrome } from "./useWindowChrome";

type Props = {
  children: ReactNode;
  /** Interactive controls (SD, settings, …) — never put drag-region on these. */
  actions: ReactNode;
  className?: string;
};

/**
 * Single app titlebar: brand/status (drag), actions, optional Win/Linux window controls.
 * Stays above Splash/Wizard so the window remains movable/closable.
 */
export function AppChrome({ children, actions, className }: Props) {
  const {
    showCustomControls,
    macOverlayInset,
    isMaximized,
    minimize,
    toggleMaximize,
    close,
  } = useWindowChrome();

  const onDragMouseDown = (e: MouseEvent) => {
    if (!showCustomControls) return;
    if (e.detail === 2) toggleMaximize();
  };

  return (
    <header
      className={cn(
        "ats-header-bg sticky top-0 z-[110] flex items-stretch border-b border-border backdrop-blur-md",
        macOverlayInset && "pl-[76px]",
        className,
      )}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      >
        {children}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 py-2.5 pr-2 pl-1">
        {actions}
      </div>

      {showCustomControls ? (
        <TitleBarControls
          isMaximized={isMaximized}
          onMinimize={minimize}
          onToggleMaximize={toggleMaximize}
          onClose={close}
        />
      ) : null}
    </header>
  );
}
