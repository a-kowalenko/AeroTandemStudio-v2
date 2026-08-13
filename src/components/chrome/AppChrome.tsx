import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MAC_TRAFFIC_LIGHT_INSET_CLASS } from "./macTrafficLights";
import { TitleBarControls } from "./TitleBarControls";
import { useWindowChrome } from "./useWindowChrome";

type Props = {
  children: ReactNode;
  /** Interactive controls (SD, settings, …) — wrapped with drag-region="false". */
  actions: ReactNode;
  className?: string;
};

/**
 * Single app titlebar: full-bar drag (`deep`), actions / window controls opted out.
 * Stays above Splash/Wizard so the window remains movable/closable.
 *
 * Tauri 2.11+: bare `data-tauri-drag-region` is self-only; `"deep"` includes
 * non-interactive children. Buttons already block drag; wrappers use `"false"`.
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
        "ats-header-bg sticky top-0 z-[110] flex cursor-default select-none items-stretch border-b border-border backdrop-blur-md",
        macOverlayInset && MAC_TRAFFIC_LIGHT_INSET_CLASS,
        className,
      )}
      data-tauri-drag-region="deep"
    >
      {/* py-[5px] + logo tile 34px → trafficLightPosition.y centers lights — see macTrafficLights.ts */}
      <div
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-[5px]"
        onMouseDown={onDragMouseDown}
      >
        {children}
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 py-[5px] pr-2 pl-1"
        data-tauri-drag-region="false"
      >
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
