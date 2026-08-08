import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import type { AppConfig } from "@/lib/tauri";
import { getAppInfo, ORT_OPTIONS } from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";

const STEPS = [
  "Willkommen",
  "Pfade",
  "Backup",
  "Server",
  "Abschluss",
] as const;

type Props = {
  open: boolean;
  onComplete: () => void;
};

export function SetupWizard({ open, onComplete }: Props) {
  const config = useConfigStore((s) => s.config);
  const persist = useConfigStore((s) => s.persist);
  const saving = useConfigStore((s) => s.saving);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const serverPhase = useServerStore((s) => s.phase);
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [testingServer, setTestingServer] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!open || !config) return;
    let cancelled = false;
    const next = { ...config };
    setDraft(next);
    setStep(0);

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

  if (!open || !draft) return null;

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function pickFolder(key: "speicherort" | "sd_backup_folder") {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") patch(key, selected);
  }

  function validateStep(index: number): string | null {
    if (!draft) return "Keine Einstellungen geladen.";
    if (index === 1 && !draft.speicherort.trim()) {
      return "Bitte einen Speicherort wählen.";
    }
    if (index === 2 && draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
      return "Bitte einen Backup-Ordner wählen oder Auto-Backup deaktivieren.";
    }
    return null;
  }

  function goNext() {
    const err = validateStep(step);
    if (err) {
      showError(err, "Einrichtung");
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function finish(markCompleted: boolean) {
    if (!draft || finishing) return;
    setFinishing(true);
    try {
      const toSave: AppConfig = {
        ...draft,
        sd_pc_name: draft.sd_pc_name.trim(),
        setup_completed: markCompleted,
      };
      const saved = await persist(toSave);
      if (!saved) {
        showError("Einstellungen konnten nicht gespeichert werden.", "Einrichtung");
        return;
      }
      if (markCompleted) {
        showSuccess("Einrichtung abgeschlossen.");
      }
      onComplete();
    } finally {
      setFinishing(false);
    }
  }

  function onSkip() {
    if (
      !window.confirm(
        "Einrichtung überspringen?\n\nSpeicherort, Backup und Server können später in den Einstellungen gesetzt werden. Einige Funktionen sind sonst eingeschränkt.",
      )
    ) {
      return;
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
      else showError(result.message, "Server");
    } finally {
      setTestingServer(false);
    }
  }

  const busy = saving || finishing;

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
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="border-b border-border px-6 py-4">
          <p className="text-xs uppercase tracking-wide text-muted">
            Schritt {step + 1} von {STEPS.length}
          </p>
          <h2
            id="setup-wizard-title"
            className="mt-1 font-display text-xl font-bold tracking-tight text-primary"
          >
            Einrichtung
          </h2>
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <span
                key={STEPS[i]}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  i <= step ? "bg-primary" : "bg-border",
                )}
              />
            ))}
          </div>
        </div>

        <div className="min-h-[280px] space-y-4 px-6 py-5">
          {step === 0 ? (
            <>
              <p className="text-sm text-foreground">
                Willkommen bei Aero Tandem Studio. In wenigen Schritten legst du
                Theme, Pfade und Server fest — alles später in den Einstellungen
                änderbar.
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
                Fertige Vorgänge werden im Speicherort abgelegt.
              </p>
              <div className="space-y-1.5">
                <Label>Speicherort</Label>
                <div className="flex gap-2">
                  <Input
                    value={draft.speicherort}
                    readOnly
                    placeholder="Ordner wählen…"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void pickFolder("speicherort")}
                  >
                    Wählen…
                  </Button>
                </div>
              </div>
              <Combobox
                label="Ort (Standard)"
                value={draft.ort}
                onChange={(v) => patch("ort", v)}
                options={ORT_OPTIONS}
                placeholder="Ort…"
              />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="text-sm text-muted">
                SD-Karten-Backups und optionaler PC-Name im Ordnernamen.
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
                  }}
                />
                Auto-Backup
              </label>
              <div className="space-y-1.5">
                <Label>Backup-Ordner</Label>
                <div className="flex gap-2">
                  <Input
                    value={draft.sd_backup_folder}
                    readOnly
                    placeholder="Ordner wählen…"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void pickFolder("sd_backup_folder")}
                  >
                    Wählen…
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>PC Name</Label>
                <Input
                  value={draft.sd_pc_name}
                  placeholder="Computername"
                  onChange={(e) => patch("sd_pc_name", e.target.value)}
                />
                <p className="text-xs text-muted">
                  Wird im Backup-Ordnernamen verwendet, z.B. SD_Backup_…[PC]_…
                </p>
              </div>
            </>
          ) : null}

          {step === 3 ? (
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
                  <Input
                    type="password"
                    value={draft.server_password}
                    onChange={(e) => patch("server_password", e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
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
                <span className="text-xs text-muted">
                  {serverPhase === "connected"
                    ? "✓ Verbunden"
                    : serverPhase === "error"
                      ? "Nicht erreichbar"
                      : null}
                </span>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="text-sm text-muted">Bitte Angaben prüfen und abschließen.</p>
              <dl className="space-y-2 rounded-lg border border-border bg-background/60 px-3 py-3 text-sm">
                <SummaryRow label="Theme" value={themeMode === "dark" ? "Dunkel" : "Hell"} />
                <SummaryRow
                  label="Speicherort"
                  value={draft.speicherort || "— nicht gesetzt —"}
                />
                <SummaryRow label="Ort" value={draft.ort || "—"} />
                <SummaryRow
                  label="Backup"
                  value={
                    draft.sd_auto_backup
                      ? draft.sd_backup_folder || "— Ordner fehlt —"
                      : "Deaktiviert"
                  }
                />
                <SummaryRow label="PC Name" value={draft.sd_pc_name || "—"} />
                <SummaryRow label="Server" value={draft.server_url || "—"} />
                <SummaryRow
                  label="Login"
                  value={draft.server_login ? draft.server_login : "—"}
                />
              </dl>
            </>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={step === 0 || busy}
              onClick={goBack}
            >
              Zurück
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" disabled={busy} onClick={goNext}>
                Weiter
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  const err = validateStep(1) || validateStep(2);
                  if (err) {
                    showError(err, "Einrichtung");
                    return;
                  }
                  void finish(true);
                }}
              >
                {busy ? "Speichern…" : "Einrichtung abschließen"}
              </Button>
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onSkip}
            className="self-center text-[11px] text-muted/70 underline-offset-2 hover:text-muted hover:underline disabled:opacity-50"
          >
            Einrichtung überspringen
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
