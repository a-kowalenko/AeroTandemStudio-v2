import { isLinuxHost, isMacOsHost, isWindowsHost } from "@/lib/utils";
import { isCustomTitlebarEnabled } from "./titlebarFlag";

export type ChromeMode = "custom-controls" | "macos-overlay" | "native";

/** Pure helper — unit-testable without Tauri. */
export function resolveChromeMode(opts?: {
  enabled?: boolean;
  mac?: boolean;
  win?: boolean;
  linux?: boolean;
}): ChromeMode {
  const enabled = opts?.enabled ?? isCustomTitlebarEnabled();
  if (!enabled) return "native";

  const mac = opts?.mac ?? isMacOsHost();
  const win = opts?.win ?? isWindowsHost();
  const linux = opts?.linux ?? isLinuxHost();

  if (mac) return "macos-overlay";
  if (win || linux) return "custom-controls";
  // Unknown / browser preview: treat like custom when flag on (no native chrome in Vite).
  return "custom-controls";
}
