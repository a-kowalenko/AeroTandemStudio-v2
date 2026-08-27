import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, Info, Languages, Loader2, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import { applyDefaultMediaDir } from "@/lib/defaultMediaDirs";
import { composeSdPcName, isAutoSdPcName, resolveSdPcName } from "@/lib/sdPcName";
import type { AppConfig, DefaultMediaDirKind, DefaultMediaDirsProposal } from "@/lib/tauri";
import {
  clearCrewRemovedName,
  crewAllNames,
  findCrewMember,
  getAppInfo,
  ORT_OPTIONS,
  proposeDefaultMediaDirs,
  upsertCrewMember,
} from "@/lib/tauri";
import { UI_LANGUAGE_OPTIONS, uiLanguageLabel } from "@/lib/uiLanguageOptions";
import { useConfigStore } from "@/store/configStore";
import { useLocaleStore } from "@/store/localeStore";
import { useServerStore } from "@/store/serverStore";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import {
  activeServerProfileSummary,
  DEFAULT_SERVER_PROFILE_ID,
  ensureWizardServerProfiles,
  switchServerProfile,
} from "@/lib/serverProfile";
import { WizardUploadServerStep } from "@/components/WizardUploadServerStep";

type DefaultDirDone = Partial<Record<DefaultMediaDirKind, boolean>>;

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.trim().replace(/[/\\]+$/, "").replace(/\\/g, "/").toLowerCase();
  return Boolean(a.trim()) && norm(a) === norm(b);
}

function StandardDirButton({
  busy,
  lockedDone,
  tone = "default",
  label,
  disabled,
  onClick,
}: {
  busy: boolean;
  lockedDone: boolean;
  /** Amber hint for adopt-existing; green when locked adopted. */
  tone?: "default" | "adopt" | "adopted";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  // Avoid native `disabled` while busy/done — opacity flash + WebView focus quirks.
  const locked = busy || lockedDone || Boolean(disabled);
  const resolvedTone = lockedDone ? "adopted" : tone;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-disabled={locked || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (locked) return;
        onClick();
      }}
      className={cn(
        "h-7 shrink-0 gap-1.5 px-2.5 text-xs transition-[color,background-color,border-color,box-shadow] duration-300 ease-out",
        locked && "pointer-events-none",
        resolvedTone === "adopted" &&
          "border-emerald-500/35 bg-emerald-500/15 text-emerald-900 shadow-none hover:bg-emerald-500/20 hover:brightness-100 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-50",
        resolvedTone === "adopt" &&
          "border-amber-400/45 bg-amber-100/90 text-amber-950 shadow-none hover:bg-amber-200/90 hover:brightness-100 dark:border-amber-400/35 dark:bg-amber-400/15 dark:text-amber-50 dark:hover:bg-amber-400/25",
      )}
    >
      {lockedDone ? (
        <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
      ) : busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : null}
      {label}
    </Button>
  );
}

function FolderDirField({
  label,
  value,
  placeholder,
  standardPath,
  standardExists,
  inputDisabled,
  pickDisabled,
  invalid,
  onPick,
  busy,
  done,
  createDisabled,
  onCreate,
  onUseStandard,
  error,
}: {
  label: string;
  value: string;
  placeholder: string;
  standardPath?: string | null;
  /** Folder already present on disk (from propose). */
  standardExists?: boolean;
  inputDisabled?: boolean;
  pickDisabled?: boolean;
  invalid?: boolean;
  onPick: () => void;
  busy: boolean;
  /** Created / adopted in this wizard session. */
  done: boolean;
  createDisabled?: boolean;
  onCreate: () => void;
  /** Adopt existing standard path without mkdir. */
  onUseStandard: () => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const usingStandard = Boolean(
    standardPath && pathsEqual(value, standardPath),
  );
  const alreadyOnDisk = Boolean(standardExists) || done;
  const showExistsStrip = Boolean(standardPath) && alreadyOnDisk;

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="relative">
        <Input
          value={value}
          readOnly
          placeholder={placeholder}
          disabled={inputDisabled}
          aria-invalid={invalid || undefined}
          className={cn(
            "pr-9",
            invalid && "border-destructive focus-visible:ring-destructive/40",
            usingStandard &&
              !invalid &&
              "border-emerald-500/40 focus-visible:ring-emerald-500/25",
          )}
        />
        <button
          type="button"
          disabled={pickDisabled || inputDisabled}
          onClick={onPick}
          title={t("common.actions.pickFolder")}
          aria-label={t("common.actions.pickFolder")}
          className={cn(
            "absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors",
            "hover:bg-primary-soft hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {standardPath && showExistsStrip ? (
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors duration-300",
            usingStandard
              ? "border-emerald-500/35 bg-emerald-500/12 dark:border-emerald-400/30 dark:bg-emerald-400/10"
              : "border-amber-400/35 bg-amber-500/[0.08] dark:border-amber-400/30 dark:bg-amber-400/[0.08]",
          )}
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              usingStandard
                ? "bg-emerald-500/20 text-emerald-800 dark:text-emerald-100"
                : "bg-amber-500/15 text-amber-800 dark:text-amber-100",
            )}
            aria-hidden
          >
            {usingStandard ? (
              <Check className="size-3.5" strokeWidth={2.5} />
            ) : (
              <Info className="size-3.5" strokeWidth={2.5} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-xs font-medium",
                usingStandard
                  ? "text-emerald-950 dark:text-emerald-50"
                  : "text-amber-950 dark:text-amber-50",
              )}
            >
              {usingStandard
                ? t("setupWizard.standardDir.active")
                : t("setupWizard.standardDir.exists")}
            </p>
            <p
              className="truncate text-[11px] text-muted"
              title={standardPath}
            >
              {standardPath}
            </p>
          </div>
          <StandardDirButton
            busy={busy}
            lockedDone={usingStandard}
            tone={usingStandard ? "adopted" : "adopt"}
            label={usingStandard ? t("setupWizard.standardDir.activeShort") : t("setupWizard.standardDir.adopt")}
            disabled={createDisabled}
            onClick={onUseStandard}
          />
        </div>
      ) : standardPath ? (
        <div className="flex items-center gap-2">
          <p
            className="min-w-0 flex-1 truncate text-xs text-muted"
            title={standardPath}
          >
            {t("setupWizard.standardDir.standardPrefix")} {standardPath}
          </p>
          <StandardDirButton
            busy={busy}
            lockedDone={false}
            label={t("setupWizard.standardDir.create")}
            disabled={createDisabled}
            onClick={onCreate}
          />
        </div>
      ) : null}
      {error ? (
        <p className="text-[11px] leading-snug text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const STEPS = [
  "setupWizard.steps.appearance",
  "setupWizard.steps.storage",
  "setupWizard.steps.import",
  "setupWizard.steps.upload",
  "setupWizard.steps.finish",
] as const;

/** Steps that can be skipped individually (not Fertig). */
const SKIPPABLE_STEPS = new Set([0, 1, 2, 3]);

const STEP_SKIP_HINT: Record<number, string> = {
  0: "setupWizard.stepHint.appearance",
  1: "setupWizard.stepHint.storage",
  2: "setupWizard.stepHint.import",
  3: "setupWizard.stepHint.server",
};

type Props = {
  open: boolean;
  onComplete: () => void;
};

type FieldErrors = {
  operator_name?: string;
  speicherort?: string;
  sd_backup_folder?: string;
  server_connection?: string;
};

type OperatorRoleDraft = {
  key: string;
  tandemmaster: boolean;
  videospringer: boolean;
};

const SKIP_BTN_CLASS =
  "border-orange-300/90 bg-orange-100 text-orange-950 hover:bg-orange-200/90 dark:border-orange-400/35 dark:bg-orange-400/15 dark:text-orange-50 dark:hover:bg-orange-400/25";

export function SetupWizard({ open, onComplete }: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const persist = useConfigStore((s) => s.persist);
  const saving = useConfigStore((s) => s.saving);
  const setLanguage = useLocaleStore((s) => s.setLanguage);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const serverConnected = useServerStore((s) => s.connected);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [skippedSteps, setSkippedSteps] = useState<Set<number>>(() => new Set());
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [uploadConnectNudge, setUploadConnectNudge] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [mediaDirsProposal, setMediaDirsProposal] =
    useState<DefaultMediaDirsProposal | null>(null);
  const [creatingDefaultDir, setCreatingDefaultDir] =
    useState<DefaultMediaDirKind | null>(null);
  const [defaultDirDone, setDefaultDirDone] = useState<DefaultDirDone>({});
  const [operatorRoles, setOperatorRoles] = useState<OperatorRoleDraft | null>(null);
  const [computerName, setComputerName] = useState("");
  const stepContentRef = useRef<HTMLDivElement>(null);
  const crewNames = crewAllNames(draft?.crew_list);

  useEffect(() => {
    if (!open || !config) return;
    let cancelled = false;
    // Wizard defaults: QR auto-scan for videos & photos on.
    const next = switchServerProfile(
      ensureWizardServerProfiles({
        ...config,
        qr_check_enabled: true,
        photo_qr_check_enabled: true,
        sd_eject_after_workflow: true,
        upload_to_server: true,
      }),
      DEFAULT_SERVER_PROFILE_ID,
    );
    const member = next.operator_name.trim()
      ? findCrewMember(next.crew_list, next.operator_name)
      : null;
    if (member?.tandemmaster && !member?.videospringer) {
      next.keep_tandemmaster_on_session_reset = true;
      next.tandemmaster = member.name;
      next.keep_videospringer_on_session_reset = false;
      next.videospringer = "";
    } else if (member?.videospringer && !member?.tandemmaster) {
      next.keep_tandemmaster_on_session_reset = false;
      next.tandemmaster = "";
      next.keep_videospringer_on_session_reset = true;
      next.videospringer = member.name;
    } else if (member?.tandemmaster && member?.videospringer) {
      next.keep_tandemmaster_on_session_reset = false;
      next.tandemmaster = "";
      next.keep_videospringer_on_session_reset = false;
      next.videospringer = "";
    }
    setOperatorRoles(
      next.operator_name.trim()
        ? {
            key: next.operator_name.trim().toLowerCase(),
            tandemmaster: Boolean(member?.tandemmaster),
            videospringer: Boolean(member?.videospringer),
          }
        : null,
    );
    setDraft(next);
    setStep(0);
    setSkippedSteps(new Set());
    setFieldErrors({});
    setMediaDirsProposal(null);
    setCreatingDefaultDir(null);
    setDefaultDirDone({});
    void getAppInfo()
      .then((info) => {
        if (cancelled) return;
        const host = info.computer_name || "";
        setComputerName(host);
        setDraft((prev) => {
          if (!prev) return prev;
          const sd_pc_name = resolveSdPcName(prev.sd_pc_name, host, prev.operator_name);
          if (sd_pc_name === prev.sd_pc_name) return prev;
          return { ...prev, sd_pc_name };
        });
      })
      .catch(() => {
        if (!cancelled) setComputerName("");
      });
    void proposeDefaultMediaDirs()
      .then((p) => {
        if (!cancelled) setMediaDirsProposal(p);
      })
      .catch(() => {
        if (!cancelled) setMediaDirsProposal(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, config]);

  useEffect(() => {
    if (!serverConnected) return;
    setFieldErrors((prev) => {
      if (!prev.server_connection) return prev;
      const next = { ...prev };
      delete next.server_connection;
      return next;
    });
  }, [serverConnected]);

  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    const container = stepContentRef.current;
    if (!container) return;
    const alert = container.querySelector('[role="alert"]');
    if (!(alert instanceof HTMLElement)) return;
    const cRect = container.getBoundingClientRect();
    const aRect = alert.getBoundingClientRect();
    const visible =
      aRect.top >= cRect.top && aRect.bottom <= cRect.bottom;
    if (!visible) {
      alert.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [fieldErrors, step]);

  if (!open || !draft) return null;

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (key === "speicherort" || key === "sd_backup_folder") {
      clearFieldError(key);
    }
    if (key === "upload_to_server" && value === false) {
      clearFieldError("server_connection");
    }
  }

  function clearFieldError(key: keyof FieldErrors) {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function applySdPcNameDefault(
    config: AppConfig,
    host: string,
    operatorName: string,
  ): AppConfig {
    if (!host.trim()) return config;
    const sd_pc_name = resolveSdPcName(config.sd_pc_name, host, operatorName);
    if (sd_pc_name === config.sd_pc_name) return config;
    return { ...config, sd_pc_name };
  }

  function applyOperatorDefaults(raw: string) {
    const name = raw.trim();
    if (name) clearFieldError("operator_name");
    setDraft((prev) => {
      if (!prev) return prev;
      let next: AppConfig = { ...prev, operator_name: raw };
      if (!name) {
        next.keep_tandemmaster_on_session_reset = false;
        next.tandemmaster = "";
        next.keep_videospringer_on_session_reset = false;
        next.videospringer = "";
        setOperatorRoles(null);
        return applySdPcNameDefault(next, computerName, "");
      }
      const member = findCrewMember(prev.crew_list, name);
      const roles = {
        tandemmaster: Boolean(member?.tandemmaster),
        videospringer: Boolean(member?.videospringer),
      };
      setOperatorRoles({
        key: name.toLowerCase(),
        tandemmaster: roles.tandemmaster,
        videospringer: roles.videospringer,
      });
      if (roles.tandemmaster && !roles.videospringer) {
        next.keep_tandemmaster_on_session_reset = true;
        next.tandemmaster = member?.name ?? name;
        next.keep_videospringer_on_session_reset = false;
        next.videospringer = "";
      } else if (roles.videospringer && !roles.tandemmaster) {
        next.keep_tandemmaster_on_session_reset = false;
        next.tandemmaster = "";
        next.keep_videospringer_on_session_reset = true;
        next.videospringer = member?.name ?? name;
      } else {
        next.keep_tandemmaster_on_session_reset = false;
        next.tandemmaster = "";
        next.keep_videospringer_on_session_reset = false;
        next.videospringer = "";
      }
      next = applySdPcNameDefault(next, computerName, name);
      return next;
    });
  }

  function setOperatorRole(role: "tandemmaster" | "videospringer", value: boolean) {
    setDraft((prev) => {
      if (!prev) return prev;
      const name = prev.operator_name.trim();
      if (!name) return prev;
      const current = operatorRoles?.key === name.toLowerCase()
        ? operatorRoles
        : {
            key: name.toLowerCase(),
            tandemmaster: Boolean(findCrewMember(prev.crew_list, name)?.tandemmaster),
            videospringer: Boolean(findCrewMember(prev.crew_list, name)?.videospringer),
          };
      const nextRoles = {
        key: current.key,
        tandemmaster: role === "tandemmaster" ? value : current.tandemmaster,
        videospringer: role === "videospringer" ? value : current.videospringer,
      };
      setOperatorRoles(nextRoles);

      let crew_list = prev.crew_list;
      let crew_removed_names = prev.crew_removed_names ?? [];
      const trimmed = name.trim();
      const idx = crew_list.findIndex(
        (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (nextRoles.tandemmaster || nextRoles.videospringer) {
        crew_list = upsertCrewMember(crew_list, trimmed, {
          tandemmaster: nextRoles.tandemmaster,
          videospringer: nextRoles.videospringer,
        });
        crew_removed_names = clearCrewRemovedName(crew_removed_names, trimmed);
      } else if (idx >= 0) {
        crew_list = crew_list.map((entry, entryIdx) =>
          entryIdx === idx
            ? {
                ...entry,
                tandemmaster: false,
                videospringer: false,
              }
            : entry,
        );
      }

      return {
        ...prev,
        crew_list,
        crew_removed_names,
        keep_tandemmaster_on_session_reset:
          nextRoles.tandemmaster && !nextRoles.videospringer,
        tandemmaster:
          nextRoles.tandemmaster && !nextRoles.videospringer ? trimmed : "",
        keep_videospringer_on_session_reset:
          nextRoles.videospringer && !nextRoles.tandemmaster,
        videospringer:
          nextRoles.videospringer && !nextRoles.tandemmaster ? trimmed : "",
      };
    });
  }

  async function pickFolder(key: "speicherort" | "sd_backup_folder") {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: mediaDirsProposal?.root || undefined,
    });
    if (typeof selected === "string") {
      patch(key, selected);
      clearFieldError(key);
      setDefaultDirDone((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function onCreateDefaultDir(kind: DefaultMediaDirKind) {
    if (creatingDefaultDir || defaultDirDone[kind]) return;
    setCreatingDefaultDir(kind);
    try {
      const result = await applyDefaultMediaDir(kind);
      if (!result) return;
      const { ensured, computerName: detectedHost } = result;
      const host = computerName || detectedHost;
      if (host && !computerName) setComputerName(host);
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (kind === "speicherort") {
          next.speicherort = ensured.path;
        } else {
          next.sd_backup_folder = ensured.path;
          if (
            host &&
            isAutoSdPcName(next.sd_pc_name, host, next.operator_name)
          ) {
            next.sd_pc_name = composeSdPcName(host, next.operator_name);
          }
        }
        return next;
      });
      clearFieldError(kind);
      setDefaultDirDone((prev) => ({ ...prev, [kind]: true }));
      // Warnings already surfaced via confirm before create; avoid SuccessDialog
      // under the wizard (z-50 vs wizard z-90) which ate the next click.
    } catch (e) {
      showError(
        e instanceof Error ? e.message : String(e),
        t("setupWizard.standardFolderTitle"),
      );
    } finally {
      setCreatingDefaultDir(null);
      // Release focus from the locked button / native confirm handoff.
      queueMicrotask(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }
  }

  function onUseExistingStandardDir(kind: DefaultMediaDirKind) {
    const path =
      kind === "speicherort"
        ? mediaDirsProposal?.speicherort
        : mediaDirsProposal?.sd_backup_folder;
    if (!path?.trim()) return;
    patch(kind, path);
    setDefaultDirDone((prev) => ({ ...prev, [kind]: true }));
  }

  function collectFieldErrors(index: number): FieldErrors {
    const errors: FieldErrors = {};
    if (!draft) return errors;
    if (index === 0 && !draft.operator_name.trim()) {
      errors.operator_name = t("setupWizard.operatorRequired");
    }
    if (index === 1 && !draft.speicherort.trim()) {
      errors.speicherort = t("setupWizard.storage.pickFolderError");
    }
    if (index === 2 && draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
      errors.sd_backup_folder =
        t("setupWizard.sd.pickFolderOrDisableAutoBackup");
    }
    if (index === 3 && draft.upload_to_server && !serverConnected) {
      errors.server_connection = t("setupWizard.upload.connectRequired");
    }
    return errors;
  }

  function hasFieldErrors(errors: FieldErrors): boolean {
    return Object.keys(errors).length > 0;
  }

  function applyValidationErrors(errors: FieldErrors, index: number) {
    setFieldErrors(errors);
    if (errors.server_connection && index === 3) {
      setUploadConnectNudge((n) => n + 1);
    }
  }

  function goNext() {
    const errors = collectFieldErrors(step);
    if (hasFieldErrors(errors)) {
      applyValidationErrors(errors, step);
      return;
    }
    setFieldErrors({});
    setSkippedSteps((prev) => {
      if (!prev.has(step)) return prev;
      const next = new Set(prev);
      next.delete(step);
      return next;
    });
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setFieldErrors({});
    setStep((s) => Math.max(s - 1, 0));
  }

  /** Advance without validation; clear incomplete optional state for this step. */
  function skipCurrentStep() {
    if (!SKIPPABLE_STEPS.has(step) || saving || finishing) return;

    if (step === 2) {
      setDraft((prev) => {
        if (!prev) return prev;
        if (!prev.sd_auto_backup || prev.sd_backup_folder.trim()) return prev;
        return {
          ...prev,
          sd_auto_backup: false,
          sd_clear_after_backup: false,
        };
      });
    }

    setFieldErrors({});
    setSkippedSteps((prev) => new Set(prev).add(step));
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function prepareForSave(markCompleted: boolean): AppConfig | null {
    if (!draft) return null;
    const withPcName = applySdPcNameDefault(
      draft,
      computerName,
      draft.operator_name,
    );
    return {
      ...withPcName,
      setup_completed: markCompleted,
    };
  }

  async function finish(markCompleted: boolean) {
    if (!draft || finishing) return;
    setFinishing(true);
    try {
      const toSave = prepareForSave(markCompleted);
      if (!toSave) return;
      const saved = await persist(toSave);
      if (!saved) {
        showError(t("setupWizard.saveFailed"), t("setupWizard.steps.finish"));
        return;
      }
      if (markCompleted) {
        showSuccess(t("setupWizard.complete"), t("setupWizard.completeTitle"), {
          autoCloseSecs: 5,
        });
      }
      onComplete();
    } finally {
      setFinishing(false);
    }
  }

  function onSkipAll() {
    if (
      !window.confirm(
        t("setupWizard.skipAllConfirm"),
      )
    ) {
      return;
    }
    void finish(true);
  }

  function finishFromSummary() {
    const checks = [0, 1, 2, 3].filter((i) => !skippedSteps.has(i));
    for (const i of checks) {
      const errors = collectFieldErrors(i);
      if (hasFieldErrors(errors)) {
        applyValidationErrors(errors, i);
        setStep(i);
        return;
      }
    }
    void finish(true);
  }

  const busy = saving || finishing;

  const canSkipStep = SKIPPABLE_STEPS.has(step);
  const skipHint = STEP_SKIP_HINT[step];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 pt-16"
      style={{
        background:
          "radial-gradient(ellipse 70% 50% at 50% 30%, var(--ats-bg-glow-1), transparent 60%), color-mix(in srgb, var(--ats-bg) 92%, black)",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-wizard-title"
    >
      <div className="flex h-[min(720px,92vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="shrink-0 border-b border-border px-6 py-4">
          <p className="text-xs uppercase tracking-wide text-muted">
            {t("setupWizard.progress", {
              current: step + 1,
              total: STEPS.length,
            })}
          </p>
          <h2
            id="setup-wizard-title"
            className="mt-1 font-display text-xl font-bold tracking-tight text-primary"
          >
            {t(STEPS[step])}
          </h2>
          <div
            className="mt-3 flex h-2 items-center gap-1.5"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            aria-label={t("setupWizard.progressAria", {
              current: step + 1,
              total: STEPS.length,
            })}
          >
            {STEPS.map((name, i) => (
              <span
                key={name}
                title={t(name)}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "flex-1 self-center rounded-full transition-[height,background-color,box-shadow] duration-300 ease-out",
                  i === step
                    ? "h-2 bg-primary shadow-[inset_0_0_0_1px] shadow-primary/40"
                    : skippedSteps.has(i)
                      ? "h-1.5 bg-primary/30"
                      : i < step
                        ? "h-1.5 bg-primary/55"
                        : "h-1.5 bg-border",
                )}
              />
            ))}
          </div>
        </div>

        <div
          ref={stepContentRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5"
        >
          {step === 0 ? (
            <>
              <p className="text-sm text-foreground">
                {t("setupWizard.intro.appearance")}
              </p>
              <div className="space-y-2">
                <Label>{t("common.labels.language")}</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {UI_LANGUAGE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        patch("ui_language", value);
                        void setLanguage(value);
                      }}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm transition-colors",
                        draft.ui_language === value
                          ? "border-primary bg-primary-soft text-primary"
                          : "border-border bg-background text-foreground hover:bg-muted/30",
                      )}
                    >
                      <Languages className="h-4 w-4 opacity-70" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t("settings.general.appearance.title")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      {
                        mode: "light" as ThemeMode,
                        label: t("common.labels.themeLight"),
                        Icon: Sun,
                      },
                      {
                        mode: "dark" as ThemeMode,
                        label: t("common.labels.themeDark"),
                        Icon: Moon,
                      },
                    ] as const
                  ).map(({ mode, label, Icon }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setThemeMode(mode)}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm transition-colors",
                        themeMode === mode
                          ? "border-primary bg-primary-soft text-primary"
                          : "border-border bg-background text-foreground hover:bg-muted/30",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <Combobox
                  label={t("settings.crew.who.label")}
                  value={draft.operator_name}
                  onChange={applyOperatorDefaults}
                  options={crewNames}
                  placeholder={t("settings.crew.who.placeholder")}
                  hint={t("setupWizard.operatorHint")}
                  error={fieldErrors.operator_name}
                  listZIndex={200}
                />
                {draft.operator_name.trim() && operatorRoles ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
                      <span>{t("create.ready.chips.tandemmaster")}</span>
                      <Switch
                        checked={operatorRoles.tandemmaster}
                        onCheckedChange={(v) => setOperatorRole("tandemmaster", v)}
                        aria-label={t("create.ready.chips.tandemmaster")}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
                      <span>{t("create.ready.chips.videospringer")}</span>
                      <Switch
                        checked={operatorRoles.videospringer}
                        onCheckedChange={(v) => setOperatorRole("videospringer", v)}
                        aria-label={t("create.ready.chips.videospringer")}
                      />
                    </label>
                  </div>
                ) : null}
                {draft.operator_name.trim() ? (
                  <p className="text-[11px] leading-snug text-muted">
                    {draft.keep_tandemmaster_on_session_reset && !draft.keep_videospringer_on_session_reset
                      ? t("setupWizard.operatorSingleRoleTm")
                      : draft.keep_videospringer_on_session_reset &&
                          !draft.keep_tandemmaster_on_session_reset
                        ? t("setupWizard.operatorSingleRoleVs")
                        : t("setupWizard.operatorMultiRole")}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <p className="text-sm text-muted">
                {t("setupWizard.intro.storage")}
              </p>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("settings.general.storage.title")}
                </p>
                <FolderDirField
                  label={t("common.labels.storageLocation")}
                  value={draft.speicherort}
                  placeholder={t("setupWizard.storage.folderPlaceholder")}
                  standardPath={mediaDirsProposal?.speicherort}
                  standardExists={Boolean(mediaDirsProposal?.speicherort_exists)}
                  invalid={Boolean(fieldErrors.speicherort)}
                  onPick={() => void pickFolder("speicherort")}
                  busy={creatingDefaultDir === "speicherort"}
                  done={Boolean(defaultDirDone.speicherort)}
                  createDisabled={
                    creatingDefaultDir !== null &&
                    creatingDefaultDir !== "speicherort"
                  }
                  onCreate={() => void onCreateDefaultDir("speicherort")}
                  onUseStandard={() => onUseExistingStandardDir("speicherort")}
                  error={fieldErrors.speicherort}
                />
                <Combobox
                  label={t("settings.general.storage.defaultDropzone")}
                  value={draft.ort}
                  onChange={(v) => patch("ort", v)}
                  options={ORT_OPTIONS}
                  placeholder={t("common.labels.dropzonePlaceholder")}
                  listZIndex={200}
                />
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="text-sm text-muted">
                {t("setupWizard.intro.import")}
              </p>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("setupWizard.sections.sdCards")}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_auto_backup}
                    onCheckedChange={(v) => {
                      const on = v === true;
                      setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              sd_auto_backup: on,
                              sd_clear_after_backup: on
                                ? prev.sd_clear_after_backup
                                : false,
                            }
                          : prev,
                      );
                      if (!on) clearFieldError("sd_backup_folder");
                    }}
                  />
                  {t("settings.sd.backup.auto")}
                </label>
                <p className="text-[11px] leading-snug text-muted">
                  {t("setupWizard.import.backupHint")}
                </p>
                <div
                  className={cn(
                    "space-y-3 pt-1",
                    !draft.sd_auto_backup && "opacity-50",
                  )}
                >
                  <FolderDirField
                    label={t("settings.sd.backup.folder")}
                    value={draft.sd_backup_folder}
                    placeholder={t("setupWizard.storage.folderPlaceholder")}
                    standardPath={mediaDirsProposal?.sd_backup_folder}
                    standardExists={Boolean(
                      mediaDirsProposal?.sd_backup_folder_exists,
                    )}
                    inputDisabled={!draft.sd_auto_backup}
                    pickDisabled={!draft.sd_auto_backup}
                    invalid={Boolean(fieldErrors.sd_backup_folder)}
                    onPick={() => void pickFolder("sd_backup_folder")}
                    busy={creatingDefaultDir === "sd_backup_folder"}
                    done={Boolean(defaultDirDone.sd_backup_folder)}
                    createDisabled={
                      !draft.sd_auto_backup ||
                      (creatingDefaultDir !== null &&
                        creatingDefaultDir !== "sd_backup_folder")
                    }
                    onCreate={() => void onCreateDefaultDir("sd_backup_folder")}
                    onUseStandard={() =>
                      onUseExistingStandardDir("sd_backup_folder")
                    }
                    error={fieldErrors.sd_backup_folder}
                  />
                  <label
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      !draft.sd_auto_backup && "pointer-events-none",
                    )}
                    title={
                      draft.sd_auto_backup
                        ? t("settings.sd.backup.clearAfterTitleOn")
                        : t("settings.sd.backup.clearAfterTitleOff")
                    }
                  >
                    <Checkbox
                      checked={
                        draft.sd_clear_after_backup && draft.sd_auto_backup
                      }
                      disabled={!draft.sd_auto_backup}
                      onCheckedChange={(v) =>
                        patch("sd_clear_after_backup", v === true)
                      }
                    />
                    {t("settings.sd.backup.clearAfter")}
                  </label>
                  {draft.sd_auto_backup && computerName ? (
                    <p className="text-[11px] leading-snug text-muted">
                      {t("setupWizard.import.backupPcNameHint", {
                        name: resolveSdPcName(
                          draft.sd_pc_name,
                          computerName,
                          draft.operator_name,
                        ),
                      })}
                    </p>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_auto_import}
                    onCheckedChange={(v) => patch("sd_auto_import", v === true)}
                  />
                  {t("settings.sd.import.auto")}
                </label>
                <p className="text-[11px] leading-snug text-muted">
                  {t("settings.sd.import.autoHint")}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_eject_after_workflow}
                    onCheckedChange={(v) =>
                      patch("sd_eject_after_workflow", v === true)
                    }
                  />
                  {t("settings.sd.import.eject")}
                </label>
                <p className="text-[11px] leading-snug text-muted">
                  {t("settings.sd.import.ejectHint")}
                </p>
              </div>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("setupWizard.sections.qrDetection")}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.qr_check_enabled}
                    onCheckedChange={(v) =>
                      patch("qr_check_enabled", v === true)
                    }
                  />
                  {t("settings.qr.autoScan.videos")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.photo_qr_check_enabled}
                    onCheckedChange={(v) =>
                      patch("photo_qr_check_enabled", v === true)
                    }
                  />
                  {t("settings.qr.autoScan.photos")}
                </label>
                <p className="text-[11px] leading-snug text-muted">
                  {t("setupWizard.import.qrHint")}
                </p>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="text-sm text-muted">
                {t("setupWizard.intro.upload")}
              </p>
              <p className="text-xs leading-snug text-muted/90">
                {t("setupWizard.upload.optionalNote")}
              </p>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.upload_to_server}
                    onCheckedChange={(v) =>
                      patch("upload_to_server", v === true)
                    }
                  />
                  {t("settings.server.upload.afterCreate")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_server_backup_enabled}
                    onCheckedChange={(v) =>
                      patch("sd_server_backup_enabled", v === true)
                    }
                  />
                  {t("settings.sd.backup.secondPath")}
                </label>
              </div>
              {!draft.upload_to_server ? (
                <div className="rounded-lg border border-dashed border-border bg-background/40 p-3 text-sm text-muted">
                  {t("setupWizard.upload.disabledHint")}
                </div>
              ) : (
                <WizardUploadServerStep
                  draft={draft}
                  setDraft={(next) => setDraft(next)}
                  disabled={!draft.upload_to_server}
                  connectNudge={uploadConnectNudge}
                  onError={(message, title) => showError(message, title)}
                  onSuccess={(message, title) => showSuccess(message, title)}
                />
              )}
              {fieldErrors.server_connection ? (
                <p className="text-[11px] leading-snug text-destructive" role="alert">
                  {fieldErrors.server_connection}
                </p>
              ) : null}
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="text-sm text-muted">{t("setupWizard.summary.description")}</p>
              <dl className="space-y-2 rounded-lg border border-border bg-background/60 px-3 py-3 text-sm">
                <SummaryRow
                  label={t("common.labels.language")}
                  value={uiLanguageLabel(draft.ui_language)}
                />
                <SummaryRow
                  label={t("settings.general.appearance.title")}
                  value={
                    themeMode === "dark"
                      ? t("common.labels.themeDark")
                      : t("common.labels.themeLight")
                  }
                />
                <SummaryRow
                  label={t("settings.crew.who.label")}
                  value={draft.operator_name.trim() || "—"}
                />
                <SummaryRow
                  label={t("common.labels.storageLocation")}
                  value={
                    skippedSteps.has(1) && !draft.speicherort.trim()
                      ? t("setupWizard.summary.skipped")
                        : draft.speicherort || t("setupWizard.summary.notSet")
                  }
                />
                <SummaryRow
                  label={t("settings.general.storage.defaultDropzone")}
                  value={draft.ort || "—"}
                />
                <SummaryRow
                  label={t("settings.sd.backup.title")}
                  value={
                    skippedSteps.has(2) && !draft.sd_auto_backup
                      ? t("setupWizard.summary.skipped")
                      : draft.sd_auto_backup
                        ? draft.sd_backup_folder || t("setupWizard.summary.missingFolder")
                        : t("setupWizard.summary.disabled")
                  }
                />
                {draft.sd_auto_backup ? (
                  <SummaryRow
                    label={t("settings.sd.backup.pcName")}
                    value={
                      resolveSdPcName(
                        draft.sd_pc_name,
                        computerName,
                        draft.operator_name,
                      ) || t("setupWizard.summary.notSet")
                    }
                  />
                ) : null}
                <SummaryRow
                  label={t("settings.sd.backup.clearAfter")}
                  value={
                    draft.sd_auto_backup && draft.sd_clear_after_backup
                      ? t("setupWizard.summary.on")
                      : t("setupWizard.summary.off")
                  }
                />
                <SummaryRow
                  label={t("settings.sd.import.auto")}
                  value={draft.sd_auto_import ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}
                />
                <SummaryRow
                  label={t("settings.sd.import.eject")}
                  value={draft.sd_eject_after_workflow ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}
                />
                <SummaryRow
                  label={t("setupWizard.summary.qrScan")}
                  value={
                    skippedSteps.has(2)
                      ? t("setupWizard.summary.skipped")
                      : [
                          draft.qr_check_enabled ? t("common.labels.video") : null,
                          draft.photo_qr_check_enabled ? t("common.labels.photo") : null,
                        ]
                          .filter(Boolean)
                          .join(", ") || t("setupWizard.summary.off")
                  }
                />
                <SummaryRow
                  label={t("settings.server.upload.title")}
                  value={
                    skippedSteps.has(3)
                      ? t("setupWizard.summary.skipped")
                      : draft.upload_to_server
                        ? activeServerProfileSummary(draft) ||
                          draft.server_url ||
                          t("setupWizard.summary.serverMissing")
                        : t("setupWizard.summary.disabled")
                  }
                />
                <SummaryRow
                  label={t("settings.sd.backup.secondPath")}
                  value={
                    skippedSteps.has(3)
                      ? t("setupWizard.summary.skipped")
                      : draft.sd_server_backup_enabled
                        ? t("setupWizard.summary.on")
                        : t("setupWizard.summary.off")
                  }
                />
                {draft.upload_to_server && draft.ams_bridge_display_name.trim() ? (
                  <SummaryRow
                    label={t("settings.server.ams.title")}
                    value={draft.ams_bridge_display_name}
                  />
                ) : null}
                <SummaryRow
                  label={t("settings.server.smb.login")}
                  value={draft.server_login ? draft.server_login : "—"}
                />
              </dl>
              {!draft.speicherort.trim() ? (
                <p className="text-xs text-muted">
                  {t("setupWizard.summary.storageMissingHint")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-col gap-3 border-t border-border px-6 py-4">
          {canSkipStep && skipHint ? (
            <p className="text-[11px] leading-snug text-muted/80">{t(skipHint)}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={step === 0 || busy}
              onClick={goBack}
            >
              {t("common.actions.back")}
            </Button>
            {canSkipStep ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={skipCurrentStep}
                className={SKIP_BTN_CLASS}
              >
                {t("common.actions.skip")}
              </Button>
            ) : (
              <span className="w-0 flex-1" aria-hidden />
            )}
            {step < STEPS.length - 1 ? (
              <Button type="button" disabled={busy} onClick={goNext}>
                {t("common.actions.next")}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy}
                onClick={finishFromSummary}
              >
                {busy ? t("common.actions.saving") : t("setupWizard.finish")}
              </Button>
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onSkipAll}
            className="self-center text-[11px] text-muted/70 underline-offset-2 hover:text-muted hover:underline disabled:opacity-50"
          >
            {t("setupWizard.skipAll")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-foreground">{value}</dd>
    </div>
  );
}
