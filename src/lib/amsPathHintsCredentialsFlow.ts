import { tr } from "@/i18n";
import {
  applyPathHintsToConfig,
  backupCredsFromConfig,
  copyPrimaryCredsToBackupProfile,
  credentialPromptPlan,
  patchBackupProfileCreds,
  patchPrimaryCreds,
  type CredentialProbeResult,
} from "@/lib/amsPathHintsApply";
import type { AmsPathHints } from "@/lib/amsPathHintsCore";
import {
  testServerConnection,
  type AppConfig,
  type ConnectionTestResult,
} from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";

export type PathHintsCredentialsFlowOptions = {
  config: AppConfig;
  hints: AmsPathHints;
  interactive?: boolean;
  test?: (
    overrides: {
      server_url: string;
      server_login: string;
      server_password: string;
    },
  ) => Promise<ConnectionTestResult>;
};

async function defaultTest(
  overrides: {
    server_url: string;
    server_login: string;
    server_password: string;
  },
): Promise<ConnectionTestResult> {
  return testServerConnection(overrides);
}

function promptText(opts: {
  title: string;
  body: string;
  label: string;
  password: boolean;
  initialValue: string;
  submitLabel: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const { closeDialog } = useUiStore.getState();
    useUiStore.getState().showSuccess(opts.body, opts.title, {
      autoCloseSecs: 0,
      prompt: {
        label: opts.label,
        password: opts.password,
        initialValue: opts.initialValue,
        submitLabel: opts.submitLabel,
        cancelLabel: tr("common.actions.cancel"),
        onCancel: () => {
          closeDialog();
          resolve(null);
        },
        onSubmit: (value) => {
          closeDialog();
          resolve(value);
        },
      },
    });
  });
}

/**
 * Ask login, then optionally try `candidatePassword` (e.g. AMS token) before
 * showing the password dialog.
 */
async function promptCredentialsForTarget(
  target: "primary" | "backup",
  initial: { login: string; password: string },
  opts?: {
    candidatePassword?: string;
    tryPassword?: (login: string, password: string) => Promise<boolean>;
  },
): Promise<{ login: string; password: string } | null> {
  const title =
    target === "primary"
      ? tr("settings.server.pathHints.credentialsTitlePrimary")
      : tr("settings.server.pathHints.credentialsTitleBackup");
  const body =
    target === "primary"
      ? tr("settings.server.pathHints.credentialsBodyPrimary")
      : tr("settings.server.pathHints.credentialsBodyBackup");

  const login = await promptText({
    title,
    body,
    label: tr("settings.server.smb.login"),
    password: false,
    initialValue: initial.login,
    submitLabel: tr("common.actions.next"),
  });
  if (login === null) return null;

  const candidate = opts?.candidatePassword?.trim() ?? "";
  if (candidate && opts?.tryPassword) {
    const ok = await opts.tryPassword(login, candidate);
    if (ok) {
      return { login, password: candidate };
    }
  }

  const password = await promptText({
    title,
    body,
    label: tr("settings.server.smb.password"),
    password: true,
    initialValue: initial.password,
    submitLabel: tr("common.actions.apply"),
  });
  if (password === null) return null;
  return { login, password };
}

async function probeTarget(
  test: PathHintsCredentialsFlowOptions["test"],
  url: string,
  login: string,
  password: string,
): Promise<boolean> {
  if (!url.trim()) return true;
  const result = await (test ?? defaultTest)({
    server_url: url,
    server_login: login,
    server_password: password,
  });
  return result.ok;
}

async function probeBoth(
  config: AppConfig,
  hints: AmsPathHints,
  test: PathHintsCredentialsFlowOptions["test"],
): Promise<CredentialProbeResult> {
  const backupUrl = hints.backupSmbUrl.trim();
  const backupCreds = backupCredsFromConfig(config);
  const primaryOk = await probeTarget(
    test,
    hints.primarySmbUrl,
    config.server_login,
    config.server_password,
  );
  if (!backupUrl) {
    return { primaryOk, backupOk: null };
  }
  const backupOk = await probeTarget(
    test,
    backupUrl,
    backupCreds.login,
    backupCreds.password,
  );
  return { primaryOk, backupOk };
}

function needsPrimaryPrompt(plan: ReturnType<typeof credentialPromptPlan>): boolean {
  return plan === "primary" || plan === "primary_then_maybe_backup";
}

function needsBackupPrompt(
  plan: ReturnType<typeof credentialPromptPlan>,
  probe: CredentialProbeResult,
  hasBackup: boolean,
): boolean {
  if (!hasBackup) return false;
  if (plan === "backup") return true;
  if (plan === "primary_then_maybe_backup" && probe.backupOk === false) return true;
  return false;
}

/** Prefer AMS bridge token as SMB password when it differs from the failing one. */
function smbPasswordCandidate(config: AppConfig): string {
  const token = config.ams_bridge_token?.trim() ?? "";
  if (!token) return "";
  if (token === (config.server_password ?? "")) return "";
  return token;
}

/**
 * After path hints are applied: SMB-test primary + backup, prompt credentials per matrix.
 * Guest/empty creds that work → no prompts.
 * When AMS token is set: ask login, try token as password silently, else ask password.
 */
export async function runPathHintsCredentialsFlow(
  opts: PathHintsCredentialsFlowOptions,
): Promise<AppConfig> {
  const interactive = opts.interactive ?? true;
  let config = opts.config;
  const hints = opts.hints;
  const hasBackup = Boolean(hints.backupSmbUrl.trim());
  const test = opts.test ?? defaultTest;

  let probe = await probeBoth(config, hints, test);
  let plan = credentialPromptPlan(probe, hasBackup);

  if (plan === "none") {
    if (hasBackup && probe.backupOk) {
      config = copyPrimaryCredsToBackupProfile(config);
    }
    return config;
  }

  if (!interactive) return config;

  if (needsPrimaryPrompt(plan)) {
    const candidate = smbPasswordCandidate(config);
    const creds = await promptCredentialsForTarget(
      "primary",
      {
        login: config.server_login,
        password: config.server_password,
      },
      {
        candidatePassword: candidate,
        tryPassword: (login, password) =>
          probeTarget(test, hints.primarySmbUrl, login, password),
      },
    );
    if (!creds) return config;
    config = patchPrimaryCreds(config, creds.login, creds.password);
    probe = await probeBoth(config, hints, test);
    plan = credentialPromptPlan(probe, hasBackup);
    if (plan === "none") {
      if (hasBackup && probe.backupOk) {
        config = copyPrimaryCredsToBackupProfile(config);
      }
      return config;
    }
  }

  if (needsBackupPrompt(plan, probe, hasBackup)) {
    const backupCreds = backupCredsFromConfig(config);
    const token = config.ams_bridge_token?.trim() ?? "";
    const candidate =
      token && token !== backupCreds.password ? token : "";
    const creds = await promptCredentialsForTarget(
      "backup",
      backupCreds,
      {
        candidatePassword: candidate,
        tryPassword: (login, password) =>
          probeTarget(test, hints.backupSmbUrl, login, password),
      },
    );
    if (creds) {
      config = patchBackupProfileCreds(config, creds.login, creds.password);
    }
  } else if (hasBackup && probe.primaryOk && probe.backupOk) {
    config = copyPrimaryCredsToBackupProfile(config);
  }

  return config;
}

/** Apply AMS path hints then run credential probes / prompts. */
export async function applyAmsPathHintsWithCredentials(
  opts: PathHintsCredentialsFlowOptions,
): Promise<AppConfig> {
  const withPaths = applyPathHintsToConfig(opts.config, opts.hints);
  return runPathHintsCredentialsFlow({ ...opts, config: withPaths });
}
