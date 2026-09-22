/** Stable prefix from Rust when a hardware encode fails and SW retry is offered. */
export const HARDWARE_ENCODE_FAILED_PREFIX = "HARDWARE_ENCODE_FAILED\n";

/** Parse a tagged HW-encode failure; returns technical details or `null`. */
export function parseHardwareEncodeFailure(message: string): string | null {
  if (!message.startsWith(HARDWARE_ENCODE_FAILED_PREFIX)) return null;
  const details = message.slice(HARDWARE_ENCODE_FAILED_PREFIX.length).trim();
  return details.length > 0 ? details : message;
}
