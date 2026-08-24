import { tr } from "@/i18n";
import type { CacheCleanupResult } from "@/lib/tauri";

function formatBytes(numBytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (numBytes < KB) return `${numBytes} B`;
  if (numBytes < MB) return `${(numBytes / KB).toFixed(1)} KB`;
  if (numBytes < GB) return `${(numBytes / MB).toFixed(1)} MB`;
  return `${(numBytes / GB).toFixed(2)} GB`;
}

/** Build localized cache cleanup toast from Rust counts (ignore German `summary`). */
export function presentCacheCleanupSummary(result: CacheCleanupResult): string {
  const lines = [
    tr("settings.system.cache.cleanupSummary", {
      dirs: result.deleted_dirs.length,
      files: result.deleted_files.length,
      size: formatBytes(result.bytes_freed),
    }),
  ];
  if (result.errors.length > 0) {
    lines.push(
      tr("settings.system.cache.cleanupErrors", { count: result.errors.length }),
    );
  }
  return lines.join("\n");
}
