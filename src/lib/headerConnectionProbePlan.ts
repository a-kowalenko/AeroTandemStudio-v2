/**
 * Pure plan / success helpers for the header connection probe (no i18n / `@/` imports).
 */

export type HeaderConnectionProbePlan = {
  runSmb: boolean;
  runBackup: boolean;
  backupUrl: string;
  backupLogin: string;
  backupPassword: string;
  runAms: boolean;
  /** Always attempt Cloud probe after primary targets (row omitted on no_token). */
  runCloud: boolean;
};

type OkFlag = { ok: boolean } | null;

const PROBE_SUCCESS_AUTO_CLOSE_MS = 3000;
const PROBE_SUCCESS_AUTO_CLOSE_MS_MANY = 5000;

/** Auto-dismiss delay after a fully green primary probe. */
export function probeSuccessAutoCloseMs(rowCount: number): number {
  return rowCount >= 3
    ? PROBE_SUCCESS_AUTO_CLOSE_MS_MANY
    : PROBE_SUCCESS_AUTO_CLOSE_MS;
}

export function buildHeaderConnectionProbePlan(opts: {
  serverUrl: string;
  backupEnabled: boolean;
  backupUrl: string;
  backupLogin: string;
  backupPassword: string;
  amsConfigured: boolean;
}): HeaderConnectionProbePlan {
  return {
    runSmb: Boolean(opts.serverUrl.trim()),
    runBackup: Boolean(opts.backupEnabled),
    backupUrl: opts.backupUrl.trim(),
    backupLogin: opts.backupLogin,
    backupPassword: opts.backupPassword,
    runAms: Boolean(opts.amsConfigured),
    runCloud: true,
  };
}

/** Primary targets only — Cloud alone never makes the probe fully green. */
export function computeAllPrimaryOk(
  plan: HeaderConnectionProbePlan,
  smb: OkFlag,
  backup: OkFlag,
  ams: OkFlag,
): boolean {
  const smbOk = !plan.runSmb || Boolean(smb?.ok);
  const backupOk =
    !plan.runBackup ||
    (Boolean(plan.backupUrl) && Boolean(backup?.ok));
  const amsOk = !plan.runAms || Boolean(ams?.ok);
  return smbOk && backupOk && amsOk;
}

/** Whether the Cloud probe should appear as a result row. */
export function shouldShowCloudProbeRow(probe: {
  status: string;
}): boolean {
  return probe.status !== "no_token";
}
