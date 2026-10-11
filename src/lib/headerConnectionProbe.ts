/**
 * Header connection probe: live row updates for the chip popover.
 * Settings dialogs still use `presentHeaderRetryOutcome`.
 */
import { amsOperatorTitle } from "./amsBridgeStatus";
import { tr } from "@/i18n";
import type { DialogActionKind, DialogActionStatus } from "@/store/uiStore";
import type {
  AmsBridgeHealthResult,
  CloudLookupProbeResult,
  ConnectionTestResult,
} from "./tauri";
import {
  presentAmsConnectionAction,
  presentBackupUrlMissingAction,
  presentCloudLookupProbeAction,
  presentServerConnectionAction,
} from "./headerConnectionStatus";
import {
  buildHeaderConnectionProbePlan,
  computeAllPrimaryOk,
  probeSuccessAutoCloseMs,
  shouldShowCloudProbeRow,
  type HeaderConnectionProbePlan,
} from "./headerConnectionProbePlan";

export type { HeaderConnectionProbePlan };
export {
  buildHeaderConnectionProbePlan,
  computeAllPrimaryOk,
  probeSuccessAutoCloseMs,
  shouldShowCloudProbeRow,
};

export type HeaderConnectionProbeResult = {
  rows: DialogActionStatus[];
  /** SMB + Backup + AMS all ok (Cloud alone does not count). */
  allPrimaryOk: boolean;
};

function busyRow(
  kind: Extract<DialogActionKind, "server" | "backup" | "ams" | "cloud">,
  label: string,
): DialogActionStatus {
  return {
    kind,
    label,
    tone: "skipped",
    summary: tr("common.actions.checking"),
    busy: true,
  };
}

/** Settled or in-flight slots used to rebuild an ordered row list. */
type ProbeSlots = {
  server: DialogActionStatus | null;
  backup: DialogActionStatus | null;
  ams: DialogActionStatus | null;
  cloud: DialogActionStatus | null;
};

function slotsToRows(slots: ProbeSlots): DialogActionStatus[] {
  return [slots.server, slots.backup, slots.ams, slots.cloud].filter(
    (r): r is DialogActionStatus => r != null,
  );
}

export function buildInitialProbeRows(
  plan: HeaderConnectionProbePlan,
): DialogActionStatus[] {
  return slotsToRows(buildInitialSlots(plan));
}

function buildInitialSlots(plan: HeaderConnectionProbePlan): ProbeSlots {
  return {
    server: plan.runSmb
      ? busyRow("server", tr("header.connection.serverLabel"))
      : null,
    backup: plan.runBackup
      ? plan.backupUrl
        ? busyRow("backup", tr("header.connection.serverBackupLabel"))
        : presentBackupUrlMissingAction()
      : null,
    ams: plan.runAms ? busyRow("ams", amsOperatorTitle()) : null,
    cloud: null,
  };
}

export type RunHeaderConnectionProbeOpts = {
  plan: HeaderConnectionProbePlan;
  serverUrl: string;
  login: string;
  password: string;
  runSmb: () => Promise<ConnectionTestResult | null>;
  runBackup: () => Promise<ConnectionTestResult | null>;
  runAms: () => Promise<AmsBridgeHealthResult | null>;
  runCloud: () => Promise<CloudLookupProbeResult>;
  onRows: (rows: DialogActionStatus[]) => void;
  /** When false, ignore further onRows (stale probe). */
  isCurrent?: () => boolean;
};

/**
 * Runs SMB + Backup + AMS in parallel, then Cloud.
 * Emits busy → settled rows via {@link onRows}.
 */
export async function runHeaderConnectionProbe(
  opts: RunHeaderConnectionProbeOpts,
): Promise<HeaderConnectionProbeResult> {
  const { plan } = opts;
  const slots = buildInitialSlots(plan);

  const emit = () => {
    if (opts.isCurrent && !opts.isCurrent()) return;
    opts.onRows(slotsToRows(slots));
  };

  emit();

  if (!plan.runSmb && !plan.runBackup && !plan.runAms && !plan.runCloud) {
    return { rows: slotsToRows(slots), allPrimaryOk: true };
  }

  const smbPromise = plan.runSmb
    ? opts.runSmb()
    : Promise.resolve(null);
  const backupPromise =
    plan.runBackup && plan.backupUrl
      ? opts.runBackup()
      : Promise.resolve(null);
  const amsPromise = plan.runAms
    ? opts.runAms()
    : Promise.resolve(null);

  const smbDone = smbPromise.then((smb) => {
    if (plan.runSmb && smb) {
      slots.server = presentServerConnectionAction({
        ok: smb.ok,
        rawMessage: smb.message,
        serverUrl: opts.serverUrl,
        login: opts.login,
        password: opts.password,
      });
      emit();
    }
    return smb;
  });

  const backupDone = backupPromise.then((backup) => {
    if (plan.runBackup && plan.backupUrl && backup) {
      slots.backup = presentServerConnectionAction({
        ok: backup.ok,
        rawMessage: backup.message,
        serverUrl: plan.backupUrl,
        login: plan.backupLogin,
        password: plan.backupPassword,
        label: tr("header.connection.serverBackupLabel"),
        kind: "backup",
        settingsFocus: "server-backup-url",
      });
      emit();
    }
    return backup;
  });

  const amsDone = amsPromise.then((ams) => {
    if (plan.runAms && ams) {
      slots.ams = presentAmsConnectionAction({
        ok: ams.ok,
        rawMessage: ams.message,
        displayName: ams.health?.display_name,
        baseUrl: ams.base_url,
      });
      emit();
    }
    return ams;
  });

  const [smb, backup, ams] = await Promise.all([
    smbDone,
    backupDone,
    amsDone,
  ]);

  if (plan.runCloud) {
    slots.cloud = busyRow(
      "cloud",
      tr("header.connection.cloudLookupLabel"),
    );
    emit();

    const cloud = await opts.runCloud();
    slots.cloud = shouldShowCloudProbeRow(cloud)
      ? presentCloudLookupProbeAction(cloud)
      : null;
    emit();
  }

  return {
    rows: slotsToRows(slots),
    allPrimaryOk: computeAllPrimaryOk(plan, smb, backup, ams),
  };
}
