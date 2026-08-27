import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** True when a Tauri/FFmpeg rejection is a user cancel, not a real failure. */
export function isCancellationError(error: unknown): boolean {
  let msg = "";
  if (typeof error === "string") {
    msg = error;
  } else if (error && typeof error === "object") {
    const o = error as { message?: unknown; error?: unknown };
    if (typeof o.message === "string") msg = o.message;
    else if (typeof o.error === "string") msg = o.error;
    else msg = String(error);
  } else {
    msg = String(error ?? "");
  }
  return /cancel|abgebrochen|abbruch/i.test(msg);
}

function hostPlatformString(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent || "";
  const plat =
    (
      navigator as Navigator & {
        userAgentData?: { platform?: string };
      }
    ).userAgentData?.platform ||
    navigator.platform ||
    "";
  return `${ua} ${plat}`;
}

/**
 * Host OS is Linux (WebKitGTK). Used to gate GStreamer/WebKit-only media workarounds
 * so Windows (WebView2) and macOS (WKWebView) keep their previous playback behavior.
 */
export function isLinuxHost(): boolean {
  return /linux/i.test(hostPlatformString());
}

/** Host OS is macOS (WKWebView). */
export function isMacOsHost(): boolean {
  const s = hostPlatformString();
  return /mac/i.test(s) || /darwin/i.test(s);
}

/** Host OS is Windows (WebView2). */
export function isWindowsHost(): boolean {
  return /win/i.test(hostPlatformString());
}
