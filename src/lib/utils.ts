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
