import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** True when a Tauri/FFmpeg rejection is a user cancel, not a real failure. */
export function isCancellationError(error: unknown): boolean {
  const msg = String(error ?? "");
  return /cancel|abgebrochen|abbruch/i.test(msg);
}

/**
 * Host OS is Linux (WebKitGTK). Used to gate GStreamer/WebKit-only media workarounds
 * so Windows (WebView2) and macOS (WKWebView) keep their previous playback behavior.
 */
export function isLinuxHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const plat =
    (
      navigator as Navigator & {
        userAgentData?: { platform?: string };
      }
    ).userAgentData?.platform ||
    navigator.platform ||
    "";
  return /linux/i.test(ua) || /linux/i.test(plat);
}
