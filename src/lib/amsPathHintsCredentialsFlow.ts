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

function promptLoginPassword(opts: {
  title: string;
  body: string;
  initialLogin: string;
  initialPassword: string;
}): Promise<{ login: string; password: string } | null> {
  return new Promise((resolve) => {
    const { closeDialog } = useUiStore.getState();
    let loginDraft = opts.initialLogin;

    const askPassword = () => {
      useUiStore.getState().showSuccess(opts.body, opts.title, {
        autoCloseSecs: 0,
        prompt: {
          label: tr("settings.server.smb.password"),
          password: true,
          initialValue: opts.initialPassword,
          submitLabel: tr("common.actions.apply"),
          cancelLabel: tr("common.actions.cancel"),
          onCancel: () => {
            closeDialog();
            resolve(null);
          },
          onSubmit: (password) => {
            closeDialog();
            resolve({ login: loginDraft, password });
          },
        },
      });
    };

    useUiStore.getState().showSuccess(opts.body, opts.title, {
      autoCloseSecs: 0,
      prompt: {
        label: tr("settings.server.smb.login"),
        password: false,
        initialValue: opts.initialLogin,
        submitLabel: tr("common.actions.next"),
        cancelLabel: tr("common.actions.cancel"),
        onCancel: () => {
          closeDialog();
          resolve(null);
        },
        onSubmit: (login) => {
          loginDraft = login;
          closeDialog();
          window.setTimeout(askPassword, 0);
        },
      },
    });
  });
}

async function promptCredentialsForTarget(
  target: "primary" | "backup",
  initial: { login: string; password: string },
): Promise<{ login: string; password: string } | null> {
  const title =
    target === "primary"
      ? tr("settings.server.pathHints.credentialsTitlePrimary")
      : tr("settings.server.pathHints.credentialsTitleBackup");
  const body =
    target === "primary"
      ? tr("settings.server.pathHints.credentialsBodyPrimary")
      : tr("settings.server.pathHints.credentialsBodyBackup");
  return promptLoginPassword({
    title,
    body,
    initialLogin: initial.login,
    initialPassword: initial.password,
  });
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

/**
 * After path hints are applied: SMB-test primary + backup, prompt credentials per matrix.
 * Guest/empty creds that work → no prompts.
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
    const creds = await promptCredentialsForTarget("primary", {
      login: config.server_login,
      password: config.server_password,
    });
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
    const creds = await promptCredentialsForTarget(
      "backup",
      backupCredsFromConfig(config),
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
