import { tr } from "@/i18n";
import { presentCacheCleanupSummary } from "@/lib/cacheCleanupMessages";
import type { AutoCleanupResult } from "@/lib/tauri";

/** Localized toast body when auto-cleanup deleted something; null if silent. */
export function presentAutoCleanupSummary(
  result: AutoCleanupResult,
): string | null {
  if (!result.ran) return null;
  const jobDirs = result.jobs.deleted_dirs.length;
  const jobFiles = result.jobs.deleted_files.length;
  const backupDirs = result.backups.deleted_dirs.length;
  const backupFiles = result.backups.deleted_files.length;
  const deleted =
    jobDirs + jobFiles + backupDirs + backupFiles > 0 ||
    result.jobs.bytes_freed > 0 ||
    result.backups.bytes_freed > 0;
  if (!deleted) return null;

  const parts: string[] = [];
  if (jobDirs + jobFiles > 0 || result.jobs.bytes_freed > 0) {
    parts.push(
      tr("settings.system.autoCleanup.summaryJobs", {
        summary: presentCacheCleanupSummary(result.jobs),
      }),
    );
  }
  if (backupDirs + backupFiles > 0 || result.backups.bytes_freed > 0) {
    parts.push(
      tr("settings.system.autoCleanup.summaryBackups", {
        summary: presentCacheCleanupSummary(result.backups),
      }),
    );
  }
  if (result.jobs_skipped_retryable > 0) {
    parts.push(
      tr("settings.system.autoCleanup.summarySkipped", {
        count: result.jobs_skipped_retryable,
      }),
    );
  }
  return parts.join("\n");
}
