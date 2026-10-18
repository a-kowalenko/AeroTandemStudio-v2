/** Phase 57 — missing/undefined config field defaults to enabled (matches Rust `AppConfig` default). */
export function sendErrorReportsEnabled(value: boolean | undefined): boolean {
  return value !== false;
}
