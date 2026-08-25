/** Human-readable byte size (binary units). */
export function formatBytes(numBytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (numBytes < KB) return `${numBytes} B`;
  if (numBytes < MB) return `${(numBytes / KB).toFixed(1)} KB`;
  if (numBytes < GB) return `${(numBytes / MB).toFixed(1)} MB`;
  return `${(numBytes / GB).toFixed(2)} GB`;
}
