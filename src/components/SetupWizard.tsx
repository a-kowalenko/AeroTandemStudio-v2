import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Eye, EyeOff, FolderOpen, Loader2, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { applyDefaultMediaDir } from "@/lib/defaultMediaDirs";
import type { AppConfig, DefaultMediaDirKind, DefaultMediaDirsProposal } from "@/lib/tauri";
import {
  CREW_KEEP_PINNED_OPTIONS,
  crewKeepComboboxValue,
  crewNamesForRole,
  ensureCrewRole,
  getAppInfo,
  ORT_OPTIONS,
  parseCrewKeepComboboxValue,
  proposeDefaultMediaDirs,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import {
  presentServerConnectionError,
  SERVER_GUEST_HINT,
  serverConnectionStatusLabel,
} from "@/lib/serverStatus";

type DefaultDirDone = Partial<Record<DefaultMediaDirKind, boolean>>;

function StandardDirButton({
  busy,
  done,
  disabled,
  onClick,
}: {
  busy: boolean;
  done: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  // Avoid native `disabled` while busy/done — opacity flash + WebView focus quirks.
  const locked = busy || done || Boolean(disabled);
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
        done &&
          "border-emerald-500/35 bg-emerald-500/15 text-emerald-900 shadow-none hover:bg-emerald-500/20 hover:brightness-100 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-50",
      )}
    >
      {done ? (
        <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
      ) : busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : null}
      {done ? "Angelegt" : "Standard anlegen"}
    </Button>
  );
}

function FolderDirField({
  label,
  value,
  placeholder,
  standardPath,
  inputDisabled,
  pickDisabled,
  invalid,
  onPick,
  busy,
  done,
  createDisabled,
  onCreate,
  error,
}: {
  label: string;
  value: string;
  placeholder: string;
  standardPath?: string | null;
  inputDisabled?: boolean;
  pickDisabled?: boolean;
  invalid?: boolean;
  onPick: () => void;
  busy: boolean;
  done: boolean;
  createDisabled?: boolean;
  onCreate: () => void;
  error?: string;
}) {
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
          )}
        />
        <button
          type="button"
          disabled={pickDisabled || inputDisabled}
          onClick={onPick}
          title="Ordner wählen"
          aria-label="Ordner wählen"
          className={cn(
            "absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors",
            "hover:bg-primary-soft hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {standardPath ? (
        <div className="flex items-center gap-2">
          <p
            className="min-w-0 flex-1 truncate text-xs text-muted"
            title={standardPath}
          >
            Standard: {standardPath}
          </p>
          <StandardDirButton
            busy={busy}
            done={done}
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
  "Darstellung",
  "Crew",
  "Speicherort",
  "SD-Backup",
  "QR-Scan",
  "Server",
  "Fertig",
] as const;

/** Steps that can be skipped individually (not Fertig). */
const SKIPPABLE_STEPS = new Set([0, 1, 2, 3, 4, 5]);

const STEP_SKIP_HINT: Record<number, string> = {
  0: "Darstellung kannst du später jederzeit umschalten.",
  1: "Crew-Defaults können später in den Einstellungen gesetzt werden.",
  2: "Ohne Speicherort können Vorgänge nicht abgelegt werden — später in den Einstellungen setzbar.",
  3: "Backup, Leeren/Auswerfen, Auto-Import und Limits sind optional und später änderbar.",
  4: "QR-Scan-Optionen können später in den Einstellungen gesetzt werden.",
  5: "Server-Zugang kann später eingerichtet werden.",
};

type Props = {
  open: boolean;
  onComplete: () => void;
};

type FieldErrors = {
  tandemmaster?: string;
  videospringer?: string;
  speicherort?: string;
  sd_backup_folder?: string;
  sd_size_limit_mb?: string;
};

const SKIP_BTN_CLASS =
  "border-orange-300/90 bg-orange-100 text-orange-950 hover:bg-orange-200/90 dark:border-orange-400/35 dark:bg-orange-400/15 dark:text-orange-50 dark:hover:bg-orange-400/25";

export function SetupWizard({ open, onComplete }: Props) {
  const config = useConfigStore((s) => s.config);
  const persist = useConfigStore((s) => s.persist);
  const saving = useConfigStore((s) => s.saving);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const serverPhase = useServerStore((s) => s.phase);
  const serverMessage = useServerStore((s) => s.message);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [skippedSteps, setSkippedSteps] = useState<Set<number>>(() => new Set());
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [testingServer, setTestingServer] = useState(false);
  const [showServerPassword, setShowServerPassword] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [mediaDirsProposal, setMediaDirsProposal] =
    useState<DefaultMediaDirsProposal | null>(null);
  const [creatingDefaultDir, setCreatingDefaultDir] =
    useState<DefaultMediaDirKind | null>(null);
  const [defaultDirDone, setDefaultDirDone] = useState<DefaultDirDone>({});

  useEffect(() => {
    if (!open || !config) return;
    let cancelled = false;
    // Wizard defaults: QR auto-scan for videos & photos on.
    const next = {
      ...config,
      qr_check_enabled: true,
      photo_qr_check_enabled: true,
    };
    setDraft(next);
    setStep(0);
    setSkippedSteps(new Set());
    setFieldErrors({});
    setMediaDirsProposal(null);
    setCreatingDefaultDir(null);
    setDefaultDirDone({});
    void proposeDefaultMediaDirs()
      .then((p) => {
        if (!cancelled) setMediaDirsProposal(p);
      })
      .catch(() => {
        if (!cancelled) setMediaDirsProposal(null);
      });

    if (!next.sd_pc_name?.trim()) {
      void getAppInfo()
        .then((info) => {
          if (cancelled) return;
          setDraft((d) =>
            d && !d.sd_pc_name.trim()
              ? { ...d, sd_pc_name: info.computer_name || "" }
              : d,
          );
        })
        .catch(() => {
          /* keep empty */
        });
    }

    return () => {
      cancelled = true;
    };
  }, [open, config]);

  const tandemmasterOptions = useMemo(
    () => crewNamesForRole(draft?.crew_list, "tandemmaster"),
    [draft?.crew_list],
  );
  const videospringerOptions = useMemo(
    () => crewNamesForRole(draft?.crew_list, "videospringer"),
    [draft?.crew_list],
  );

  if (!open || !draft) return null;

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (key === "speicherort" || key === "sd_backup_folder") {
      clearFieldError(key);
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
      const { ensured, computerName } = result;
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (kind === "speicherort") {
          next.speicherort = ensured.path;
        } else {
          next.sd_backup_folder = ensured.path;
          if (!next.sd_pc_name.trim() && computerName) {
            next.sd_pc_name = computerName;
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
        "Standardordner",
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

  function setCrewKeep(
    role: "tandemmaster" | "videospringer",
    raw: string,
  ) {
    const { keep, name } = parseCrewKeepComboboxValue(raw);
    setDraft((prev) => {
      if (!prev) return prev;
      if (role === "tandemmaster") {
        return {
          ...prev,
          keep_tandemmaster_on_session_reset: keep,
          tandemmaster: name,
        };
      }
      return {
        ...prev,
        keep_videospringer_on_session_reset: keep,
        videospringer: name,
      };
    });
    clearFieldError(role);
  }

  function collectFieldErrors(index: number): FieldErrors {
    const errors: FieldErrors = {};
    if (!draft) return errors;
    // Step 1: keep-last (empty name) and keep-off are both valid; only fixed names need crew sync on finish.
    if (index === 2 && !draft.speicherort.trim()) {
      errors.speicherort = "Bitte einen Ordner wählen.";
    }
    if (index === 3 && draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
      errors.sd_backup_folder =
        "Ordner wählen oder Auto-Backup deaktivieren.";
    }
    if (index === 3 && draft.sd_size_limit_enabled) {
      const mb = Number(draft.sd_size_limit_mb);
      if (!Number.isFinite(mb) || mb < 1) {
        errors.sd_size_limit_mb = "Gültiges Limit in MB angeben.";
      }
    }
    return errors;
  }

  function hasFieldErrors(errors: FieldErrors): boolean {
    return Object.keys(errors).length > 0;
  }

  function goNext() {
    const errors = collectFieldErrors(step);
    if (hasFieldErrors(errors)) {
      setFieldErrors(errors);
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

    if (step === 1) {
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              keep_tandemmaster_on_session_reset: false,
              keep_videospringer_on_session_reset: false,
              tandemmaster: "",
              videospringer: "",
            }
          : prev,
      );
    } else if (step === 3) {
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
    let crew_list = draft.crew_list;
    const tm = draft.tandemmaster.trim();
    const vs = draft.videospringer.trim();
    if (draft.keep_tandemmaster_on_session_reset && tm) {
      crew_list = ensureCrewRole(crew_list, tm, "tandemmaster");
    }
    if (draft.keep_videospringer_on_session_reset && vs) {
      crew_list = ensureCrewRole(crew_list, vs, "videospringer");
    }
    return {
      ...draft,
      tandemmaster: draft.keep_tandemmaster_on_session_reset ? tm : "",
      videospringer: draft.keep_videospringer_on_session_reset ? vs : "",
      crew_list,
      sd_pc_name: draft.sd_pc_name.trim(),
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
        showError("Einstellungen konnten nicht gespeichert werden.", "Einrichtung");
        return;
      }
      if (markCompleted) {
        showSuccess("Einrichtung abgeschlossen.", "Erfolg", {
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
        "Gesamte Einrichtung überspringen?\n\nSpeicherort, Backup und Server können später in den Einstellungen gesetzt werden. Einige Funktionen sind sonst eingeschränkt.",
      )
    ) {
      return;
    }
    void finish(true);
  }

  function finishFromSummary() {
    const checks = [1, 2, 3].filter((i) => !skippedSteps.has(i));
    for (const i of checks) {
      const errors = collectFieldErrors(i);
      if (hasFieldErrors(errors)) {
        setFieldErrors(errors);
        setStep(i);
        return;
      }
    }
    void finish(true);
  }

  async function onTestServer() {
    if (!draft) return;
    setTestingServer(true);
    try {
      const result = await checkConnection({
        server_url: draft.server_url,
        server_login: draft.server_login,
        server_password: draft.server_password,
      });
      if (result.ok) showSuccess(result.message, "Server");
      else {
        const presented = presentServerConnectionError({
          rawMessage: result.message,
          serverUrl: draft.server_url,
          login: draft.server_login,
          password: draft.server_password,
          omitSettingsAction: true,
        });
        showError(presented.message, "Server");
      }
    } finally {
      setTestingServer(false);
    }
  }

  const busy = saving || finishing;

  function keepSummary(): string {
    if (!draft) return "—";
    if (skippedSteps.has(1)) return "— übersprungen —";
    const parts: string[] = [];
    if (draft.keep_tandemmaster_on_session_reset) {
      const tm = draft.tandemmaster.trim();
      parts.push(tm ? `TM: ${tm}` : "TM: zuletzt verwendet");
    }
    if (draft.keep_videospringer_on_session_reset) {
      const vs = draft.videospringer.trim();
      parts.push(vs ? `VS: ${vs}` : "VS: zuletzt verwendet");
    }
    return parts.length > 0 ? parts.join(", ") : "Keine (werden zurückgesetzt)";
  }

  const canSkipStep = SKIPPABLE_STEPS.has(step);
  const skipHint = STEP_SKIP_HINT[step];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
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
            Schritt {step + 1} von {STEPS.length}
          </p>
          <h2
            id="setup-wizard-title"
            className="mt-1 font-display text-xl font-bold tracking-tight text-primary"
          >
            {STEPS[step]}
          </h2>
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <span
                key={STEPS[i]}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  skippedSteps.has(i)
                    ? "bg-primary/35"
                    : i <= step
                      ? "bg-primary"
                      : "bg-border",
                )}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {step === 0 ? (
            <>
              <p className="text-sm text-foreground">
                Willkommen bei Aero Tandem Studio. In wenigen Schritten legst du
                Darstellung, Crew, Speicherort, SD-Backup, QR-Scan und Server
                fest — alles später in den Einstellungen änderbar.
              </p>
              <div className="space-y-2">
                <Label>Darstellung</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { mode: "light" as ThemeMode, label: "Hell", Icon: Sun },
                      { mode: "dark" as ThemeMode, label: "Dunkel", Icon: Moon },
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
            </>
          ) : null}

          {step === 1 ? (
            <>
              <p className="text-sm text-muted">
                Nach dem Erstellen eines Vorgangs wird die Session
                zurückgesetzt. Wähle oben im Dropdown den Modus oder einen
                festen Namen.
              </p>

              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <Combobox
                  label="Tandemmaster"
                  value={crewKeepComboboxValue(
                    draft.keep_tandemmaster_on_session_reset,
                    draft.tandemmaster,
                  )}
                  onChange={(v) => setCrewKeep("tandemmaster", v)}
                  options={tandemmasterOptions}
                  pinnedOptions={CREW_KEEP_PINNED_OPTIONS}
                  placeholder="Modus oder Name wählen…"
                  hint="Neuer Name wird automatisch zur Crew-Liste hinzugefügt."
                  error={fieldErrors.tandemmaster}
                  listZIndex={200}
                />
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <Combobox
                  label="Videospringer"
                  value={crewKeepComboboxValue(
                    draft.keep_videospringer_on_session_reset,
                    draft.videospringer,
                  )}
                  onChange={(v) => setCrewKeep("videospringer", v)}
                  options={videospringerOptions}
                  pinnedOptions={CREW_KEEP_PINNED_OPTIONS}
                  placeholder="Modus oder Name wählen…"
                  hint="Neuer Name wird automatisch zur Crew-Liste hinzugefügt."
                  error={fieldErrors.videospringer}
                  listZIndex={200}
                />
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="text-sm text-muted">
                Fertige Vorgänge werden im Speicherort abgelegt.
              </p>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Ablage
                </p>
                <FolderDirField
                  label="Speicherort"
                  value={draft.speicherort}
                  placeholder="Ordner wählen…"
                  standardPath={mediaDirsProposal?.speicherort}
                  invalid={Boolean(fieldErrors.speicherort)}
                  onPick={() => void pickFolder("speicherort")}
                  busy={creatingDefaultDir === "speicherort"}
                  done={Boolean(defaultDirDone.speicherort)}
                  createDisabled={
                    creatingDefaultDir !== null &&
                    creatingDefaultDir !== "speicherort"
                  }
                  onCreate={() => void onCreateDefaultDir("speicherort")}
                  error={fieldErrors.speicherort}
                />
              </div>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <Combobox
                  label="Dropzone (Standard)"
                  value={draft.ort}
                  onChange={(v) => patch("ort", v)}
                  options={ORT_OPTIONS}
                  placeholder="Dropzone…"
                  listZIndex={200}
                />
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="text-sm text-muted">
                SD-Karten-Backups, Aufräumen nach dem Workflow und optionales
                Größenlimit.
              </p>

              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Backup
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
                  Auto-Backup
                </label>
                <div
                  className={cn(
                    "space-y-3",
                    !draft.sd_auto_backup && "opacity-50",
                  )}
                >
                  <FolderDirField
                    label="Backup-Ordner"
                    value={draft.sd_backup_folder}
                    placeholder="Ordner wählen…"
                    standardPath={mediaDirsProposal?.sd_backup_folder}
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
                    error={fieldErrors.sd_backup_folder}
                  />
                  <div className="space-y-1.5">
                    <Label>PC Name</Label>
                    <Input
                      value={draft.sd_pc_name}
                      placeholder="Computername"
                      disabled={!draft.sd_auto_backup}
                      onChange={(e) => patch("sd_pc_name", e.target.value)}
                    />
                    <p className="text-xs text-muted">
                      Wird im Backup-Ordnernamen verwendet, z.B.
                      SD_Backup_…[
                      {draft.sd_pc_name.trim() || "PC"}
                      ]_…
                    </p>
                  </div>
                  <label
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      !draft.sd_auto_backup && "pointer-events-none",
                    )}
                    title={
                      draft.sd_auto_backup
                        ? "SD-Karte nach erfolgreichem Backup leeren"
                        : "Nur möglich, wenn Auto-Backup aktiviert ist"
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
                    SD nach Backup leeren
                  </label>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Import & Auswerfen
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_auto_import}
                    onCheckedChange={(v) => patch("sd_auto_import", v === true)}
                  />
                  Auto-Import
                </label>
                <p className="text-[11px] leading-snug text-muted">
                  Nach dem Backup passende Medien automatisch in die Session
                  laden.
                </p>
                <label
                  className="flex items-center gap-2 text-sm"
                  title="SD-Karte nach erfolgreichem Backup/Import sicher auswerfen"
                >
                  <Checkbox
                    checked={draft.sd_eject_after_workflow}
                    onCheckedChange={(v) =>
                      patch("sd_eject_after_workflow", v === true)
                    }
                  />
                  SD nach Workflow auswerfen
                </label>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Warnschwelle
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.sd_size_limit_enabled}
                    onCheckedChange={(v) => {
                      const on = v === true;
                      patch("sd_size_limit_enabled", on);
                      if (!on) clearFieldError("sd_size_limit_mb");
                    }}
                  />
                  Größen-Limit aktivieren
                </label>
                <div
                  className={cn(
                    "space-y-1.5 pl-1",
                    !draft.sd_size_limit_enabled &&
                      "pointer-events-none opacity-50",
                  )}
                >
                  <Label>Größen-Limit (MB)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.sd_size_limit_mb}
                    disabled={!draft.sd_size_limit_enabled}
                    aria-invalid={
                      fieldErrors.sd_size_limit_mb ? true : undefined
                    }
                    className={cn(
                      fieldErrors.sd_size_limit_mb &&
                        "border-destructive focus-visible:ring-destructive/40",
                    )}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      patch(
                        "sd_size_limit_mb",
                        Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
                      );
                      if (Number.isFinite(n) && n >= 1) {
                        clearFieldError("sd_size_limit_mb");
                      }
                    }}
                  />
                  {fieldErrors.sd_size_limit_mb ? (
                    <p
                      className="text-[11px] leading-snug text-destructive"
                      role="alert"
                    >
                      {fieldErrors.sd_size_limit_mb}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted">
                      Warnung / Bestätigung, wenn die SD-Karte dieses Limit
                      überschreitet (Standard: 3000 MB).
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="text-sm text-muted">
                Automatische QR-Erkennung beim Import und Aufräumen nach dem
                Scan.
              </p>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Auto-Scan beim Import
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.qr_check_enabled}
                    onCheckedChange={(v) =>
                      patch("qr_check_enabled", v === true)
                    }
                  />
                  Videos beim Import scannen
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.photo_qr_check_enabled}
                    onCheckedChange={(v) =>
                      patch("photo_qr_check_enabled", v === true)
                    }
                  />
                  Fotos beim Import scannen
                </label>
              </div>
              <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Nach QR-Analyse
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.qr_remove_photo_after_scan}
                    onCheckedChange={(v) =>
                      patch("qr_remove_photo_after_scan", v === true)
                    }
                  />
                  QR-Foto nach Scan entfernen
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.qr_remove_video_after_scan}
                    onCheckedChange={(v) =>
                      patch("qr_remove_video_after_scan", v === true)
                    }
                  />
                  QR-Videoclip nach Scan entfernen
                </label>
                <div
                  className={cn(
                    "space-y-1.5 pl-1",
                    !draft.qr_remove_video_after_scan &&
                      "pointer-events-none opacity-50",
                  )}
                >
                  <Label>Max. QR-Videolänge für Löschung (Sek.)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    value={draft.qr_remove_video_max_duration_sec}
                    disabled={!draft.qr_remove_video_after_scan}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      patch(
                        "qr_remove_video_max_duration_sec",
                        Number.isFinite(n)
                          ? Math.min(300, Math.max(1, Math.round(n)))
                          : 10,
                      );
                    }}
                  />
                  <p className="text-[11px] text-muted">
                    Nur Clips mit dieser Länge oder kürzer werden entfernt
                    (Standard: 10s).
                  </p>
                </div>
              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <p className="text-sm text-muted">
                SMB-Server für Upload. Kann auch später eingerichtet werden.
              </p>
              <div className="space-y-1.5">
                <Label>Server-URL</Label>
                <Input
                  value={draft.server_url}
                  onChange={(e) => patch("server_url", e.target.value)}
                  placeholder="smb://…"
                />
              </div>
              <div className="space-y-1.5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Login</Label>
                    <Input
                      value={draft.server_login}
                      onChange={(e) => patch("server_login", e.target.value)}
                      autoComplete="username"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Passwort</Label>
                    <div className="relative">
                      <Input
                        type={showServerPassword ? "text" : "password"}
                        value={draft.server_password}
                        onChange={(e) =>
                          patch("server_password", e.target.value)
                        }
                        autoComplete="current-password"
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowServerPassword((prev) => !prev)
                        }
                        title={
                          showServerPassword
                            ? "Passwort verbergen"
                            : "Passwort anzeigen"
                        }
                        aria-label={
                          showServerPassword
                            ? "Passwort verbergen"
                            : "Passwort anzeigen"
                        }
                        className={cn(
                          "absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors",
                          "hover:bg-primary-soft hover:text-foreground",
                        )}
                      >
                        {showServerPassword ? (
                          <EyeOff className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-muted">{SERVER_GUEST_HINT}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={testingServer}
                  onClick={() => void onTestServer()}
                >
                  {testingServer ? "Prüfe…" : "Verbindung testen"}
                </Button>
                {!testingServer &&
                serverPhase !== "checking" &&
                serverPhase !== "idle" ? (
                  <button
                    type="button"
                    className="cursor-pointer rounded text-xs text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={
                      serverPhase === "error" && serverMessage
                        ? `${serverMessage}\nKlicken zum erneuten Prüfen`
                        : "Klicken zum erneuten Prüfen"
                    }
                    onClick={() => void onTestServer()}
                  >
                    {serverConnectionStatusLabel(serverPhase, serverMessage)}
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <>
              <p className="text-sm text-muted">Bitte Angaben prüfen und abschließen.</p>
              <dl className="space-y-2 rounded-lg border border-border bg-background/60 px-3 py-3 text-sm">
                <SummaryRow
                  label="Theme"
                  value={themeMode === "dark" ? "Dunkel" : "Hell"}
                />
                <SummaryRow label="Crew" value={keepSummary()} />
                <SummaryRow
                  label="Speicherort"
                  value={
                    skippedSteps.has(2) && !draft.speicherort.trim()
                      ? "— übersprungen —"
                      : draft.speicherort || "— nicht gesetzt —"
                  }
                />
                <SummaryRow label="Dropzone" value={draft.ort || "—"} />
                <SummaryRow
                  label="Backup"
                  value={
                    skippedSteps.has(3) && !draft.sd_auto_backup
                      ? "— übersprungen —"
                      : draft.sd_auto_backup
                        ? draft.sd_backup_folder || "— Ordner fehlt —"
                        : "Deaktiviert"
                  }
                />
                <SummaryRow
                  label="SD leeren"
                  value={
                    draft.sd_clear_after_backup && draft.sd_auto_backup
                      ? "An"
                      : "Aus"
                  }
                />
                <SummaryRow
                  label="SD auswerfen"
                  value={draft.sd_eject_after_workflow ? "An" : "Aus"}
                />
                <SummaryRow
                  label="Auto-Import"
                  value={draft.sd_auto_import ? "An" : "Aus"}
                />
                <SummaryRow
                  label="Größenlimit"
                  value={
                    draft.sd_size_limit_enabled
                      ? `${draft.sd_size_limit_mb} MB`
                      : "Aus"
                  }
                />
                <SummaryRow label="PC Name" value={draft.sd_pc_name || "—"} />
                <SummaryRow
                  label="QR-Scan"
                  value={
                    skippedSteps.has(4)
                      ? "— übersprungen —"
                      : [
                          draft.qr_check_enabled ? "Video" : null,
                          draft.photo_qr_check_enabled ? "Foto" : null,
                        ]
                          .filter(Boolean)
                          .join(", ") || "Aus"
                  }
                />
                <SummaryRow
                  label="QR entfernen"
                  value={
                    [
                      draft.qr_remove_photo_after_scan ? "Foto" : null,
                      draft.qr_remove_video_after_scan
                        ? `Video ≤${draft.qr_remove_video_max_duration_sec}s`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "Aus"
                  }
                />
                <SummaryRow
                  label="Server"
                  value={
                    skippedSteps.has(5)
                      ? "— übersprungen —"
                      : draft.server_url || "—"
                  }
                />
                <SummaryRow
                  label="Login"
                  value={draft.server_login ? draft.server_login : "—"}
                />
              </dl>
              {!draft.speicherort.trim() ? (
                <p className="text-xs text-muted">
                  Ohne Speicherort können Vorgänge nicht abgelegt werden. Du
                  kannst ihn jederzeit in den Einstellungen setzen.
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-col gap-3 border-t border-border px-6 py-4">
          {canSkipStep && skipHint ? (
            <p className="text-[11px] leading-snug text-muted/80">{skipHint}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={step === 0 || busy}
              onClick={goBack}
            >
              Zurück
            </Button>
            {canSkipStep ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={skipCurrentStep}
                className={SKIP_BTN_CLASS}
              >
                Überspringen
              </Button>
            ) : (
              <span className="w-0 flex-1" aria-hidden />
            )}
            {step < STEPS.length - 1 ? (
              <Button type="button" disabled={busy} onClick={goNext}>
                Weiter
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy}
                onClick={finishFromSummary}
              >
                {busy ? "Speichern…" : "Einrichtung abschließen"}
              </Button>
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onSkipAll}
            className="self-center text-[11px] text-muted/70 underline-offset-2 hover:text-muted hover:underline disabled:opacity-50"
          >
            Gesamte Einrichtung überspringen
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
