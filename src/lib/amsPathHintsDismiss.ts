import {
  type PathHintsDriftDismissState,
} from "./amsPathHintsCore";

const STORAGE_KEY = "ats.amsPathHints.driftDismiss";

export function readPathHintsDriftDismiss(): PathHintsDriftDismissState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PathHintsDriftDismissState;
    if (
      typeof parsed.driftKey !== "string" ||
      typeof parsed.hintsKey !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePathHintsDriftDismiss(
  state: PathHintsDriftDismissState,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode — dismiss is best-effort for this session.
  }
}

export function clearPathHintsDriftDismiss(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
