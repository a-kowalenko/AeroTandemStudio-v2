import { formatBytes } from "./formatBytes";

/** Human-readable throughput (binary units per second). */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}
