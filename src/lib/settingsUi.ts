/** Phase 47: Settings/Wizard information architecture. */

export type SettingsUiMode = "simple" | "advanced";

export type SettingsArea =
  | "workplace"
  | "media"
  | "connection"
  | "output"
  | "maintenance";

/** Accepts legacy tab IDs and the five Phase-47 areas. */
export type SettingsTab =
  | SettingsArea
  | "allgemein"
  | "crew"
  | "qr"
  | "encoding"
  | "sd"
  | "server"
  | "system";

export type SettingsFocusTarget =
  | "server-url"
  | "server-credentials"
  | "server-backup-url"
  | "ams-bridge-url"
  | "ams-bridge-token";

export const SETTINGS_AREAS: readonly SettingsArea[] = [
  "workplace",
  "media",
  "connection",
  "output",
  "maintenance",
] as const;

const TAB_TO_AREA: Record<string, SettingsArea> = {
  workplace: "workplace",
  allgemein: "workplace",
  crew: "workplace",
  media: "media",
  qr: "media",
  sd: "media",
  connection: "connection",
  server: "connection",
  output: "output",
  encoding: "output",
  maintenance: "maintenance",
  system: "maintenance",
};

export const FOCUS_TARGET_AREA: Record<SettingsFocusTarget, SettingsArea> = {
  "server-url": "connection",
  "server-credentials": "connection",
  "server-backup-url": "connection",
  "ams-bridge-url": "connection",
  "ams-bridge-token": "connection",
};

export function resolveSettingsArea(
  tab?: SettingsTab | string | null,
): SettingsArea {
  if (!tab) return "workplace";
  return TAB_TO_AREA[tab] ?? "workplace";
}

export function normalizeSettingsUiMode(
  mode: string | null | undefined,
): SettingsUiMode {
  return mode === "advanced" ? "advanced" : "simple";
}

export type SettingsDisclosure = {
  uiMode: SettingsUiMode;
  /** Deep-link focus: show the field even in simple mode (no persist flip). */
  revealedFocus: SettingsFocusTarget | null;
};

export function showAdvanced(
  disclosure: SettingsDisclosure | undefined,
  focusTargets?: readonly SettingsFocusTarget[],
): boolean {
  if (!disclosure || disclosure.uiMode === "advanced") return true;
  const focus = disclosure.revealedFocus;
  return Boolean(focus && focusTargets?.includes(focus));
}

export function isFocusRevealed(
  disclosure: SettingsDisclosure | undefined,
  focusTargets: readonly SettingsFocusTarget[],
): boolean {
  if (!disclosure || disclosure.uiMode !== "simple") return false;
  const focus = disclosure.revealedFocus;
  return Boolean(focus && focusTargets.includes(focus));
}

export type WizardStepId =
  | "mode"
  | "workplace"
  | "storage"
  | "media"
  | "connection"
  | "output"
  | "finish";

export function wizardStepsForMode(mode: SettingsUiMode): WizardStepId[] {
  if (mode === "simple") {
    return ["mode", "workplace", "connection", "finish"];
  }
  return [
    "mode",
    "workplace",
    "storage",
    "media",
    "connection",
    "output",
    "finish",
  ];
}

/** Easy-mode / first-run media defaults — all workflow toggles on. */
export function applySimpleWizardMediaDefaults<
  T extends {
    qr_check_enabled: boolean;
    photo_qr_check_enabled: boolean;
    sd_auto_backup: boolean;
    sd_auto_import: boolean;
    sd_eject_after_workflow: boolean;
    upload_to_server: boolean;
  },
>(cfg: T): T {
  return {
    ...cfg,
    qr_check_enabled: true,
    photo_qr_check_enabled: true,
    sd_auto_backup: true,
    sd_auto_import: true,
    sd_eject_after_workflow: true,
    upload_to_server: true,
  };
}

export function isWizardStepSkippable(id: WizardStepId): boolean {
  return id !== "mode" && id !== "finish";
}

export const WIZARD_STEP_TITLE_KEY: Record<WizardStepId, string> = {
  mode: "setupWizard.steps.mode",
  workplace: "setupWizard.steps.workplace",
  storage: "setupWizard.steps.storage",
  media: "setupWizard.steps.media",
  connection: "setupWizard.steps.connection",
  output: "setupWizard.steps.output",
  finish: "setupWizard.steps.finish",
};

export const WIZARD_STEP_HINT_KEY: Partial<Record<WizardStepId, string>> = {
  workplace: "setupWizard.stepHint.workplace",
  storage: "setupWizard.stepHint.storage",
  media: "setupWizard.stepHint.media",
  connection: "setupWizard.stepHint.server",
  output: "setupWizard.stepHint.output",
};
