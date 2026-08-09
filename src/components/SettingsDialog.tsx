import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppConfig, AvailableRelease, CrewMember, ManualEntryMode } from "@/lib/tauri";
import {
  cleanupCache,
  clearWorkingSession,
  crewNamesForRole,
  ensureCrewRole,
  getAppInfo,
  installSpecificVersion,
  listAvailableVersions,
  normalizeManualEntryMode,
  ORT_OPTIONS,
  withManualEntryMode,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import { useUiStore } from "@/store/uiStore";
import { useVideoStore } from "@/store/videoStore";
import { usePhotoStore } from "@/store/photoStore";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestUpdateCheck?: () => void;
  /** After factory reset — open first-run setup wizard. */
  onAfterFactoryReset?: () => void;
  /** Keep settings open while another dialog (e.g. Update) is stacked on top. */
  suppressDismiss?: boolean;
};

export function SettingsDialog({
  open,
  onOpenChange,
  onRequestUpdateCheck,
  onAfterFactoryReset,
  suppressDismiss = false,
}: Props) {
  const config = useConfigStore((s) => s.config);
  const persist = useConfigStore((s) => s.persist);
  const resetToDefaults = useConfigStore((s) => s.resetToDefaults);
  const saving = useConfigStore((s) => s.saving);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const serverPhase = useServerStore((s) => s.phase);
  // Select stable list refs — mapping inside the selector returns a new array
  // every getSnapshot and triggers React 19's "getSnapshot should be cached" crash.
  const videoList = useVideoStore((s) => s.videoList);
  const photoList = usePhotoStore((s) => s.photoList);
  const clearVideos = useVideoStore((s) => s.clearVideos);
  const clearPhotos = usePhotoStore((s) => s.clearPhotos);
  const videoPaths = useMemo(() => videoList.map((v) => v.path), [videoList]);
  const photoPaths = useMemo(() => photoList.map((p) => p.path), [photoList]);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [testingServer, setTestingServer] = useState(false);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [releases, setReleases] = useState<AvailableRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [showPrereleases, setShowPrereleases] = useState(false);
  const [installingVersion, setInstallingVersion] = useState(false);
  const [crewDraft, setCrewDraft] = useState<CrewMember>({
    name: "",
    tandemmaster: true,
    videospringer: false,
  });
  const [crewEditIndex, setCrewEditIndex] = useState<number | null>(null);

  const sortedCrew = useMemo(() => {
    if (!draft) return [];
    return draft.crew_list
      .map((member, index) => ({ member, index }))
      .sort((a, b) => a.member.name.localeCompare(b.member.name, "de"));
  }, [draft]);

  const tandemmasterOptions = useMemo(
    () => crewNamesForRole(draft?.crew_list, "tandemmaster"),
    [draft?.crew_list],
  );
  const videospringerOptions = useMemo(
    () => crewNamesForRole(draft?.crew_list, "videospringer"),
    [draft?.crew_list],
  );

  const filteredReleases = useMemo(() => {
    if (showPrereleases) return releases;
    return releases.filter((r) => !r.prerelease);
  }, [releases, showPrereleases]);

  const selectedRelease = useMemo(
    () => filteredReleases.find((r) => r.tag_name === selectedVersion) ?? null,
    [filteredReleases, selectedVersion],
  );

  useEffect(() => {
    if (!open || !config) return;
    let cancelled = false;
    const list = [...(config.crew_list ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, "de"),
    );
    setDraft({ ...config, crew_list: list });
    setCrewDraft({ name: "", tandemmaster: true, videospringer: false });
    setCrewEditIndex(null);

    // Legacy: empty sd_pc_name → show current computer name in the field.
    if (!config.sd_pc_name?.trim()) {
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

  useEffect(() => {
    if (!open) return;
    void getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => setAppVersion(null));

    let cancelled = false;
    setReleasesLoading(true);
    setReleasesError(null);
    void listAvailableVersions()
      .then((list) => {
        if (cancelled) return;
        setReleases(list);
        const firstStable = list.find((r) => !r.prerelease);
        setSelectedVersion(firstStable?.tag_name ?? list[0]?.tag_name ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        setReleases([]);
        setSelectedVersion("");
        setReleasesError(String(e));
      })
      .finally(() => {
        if (!cancelled) setReleasesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || releases.length === 0) return;
    const visible = showPrereleases
      ? releases
      : releases.filter((r) => !r.prerelease);
    if (appVersion && visible.some((r) => r.tag_name === appVersion)) {
      setSelectedVersion(appVersion);
      return;
    }
    setSelectedVersion((prev) =>
      visible.some((r) => r.tag_name === prev)
        ? prev
        : (visible[0]?.tag_name ?? ""),
    );
  }, [appVersion, open, releases, showPrereleases]);

  if (!draft) return null;

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function resetCrewForm() {
    setCrewDraft({ name: "", tandemmaster: true, videospringer: false });
    setCrewEditIndex(null);
  }

  function startEditCrew(index: number) {
    if (!draft) return;
    const member = draft.crew_list[index];
    if (!member) return;
    setCrewDraft({ ...member });
    setCrewEditIndex(index);
  }

  function saveCrewMember() {
    if (!draft) return;
    const name = crewDraft.name.trim();
    if (!name) {
      showError("Bitte einen Namen eingeben.", "Crew");
      return;
    }
    const duplicate = draft.crew_list.some(
      (c, i) =>
        c.name.trim().toLowerCase() === name.toLowerCase() &&
        i !== crewEditIndex,
    );
    if (duplicate) {
      showError("Dieser Name ist bereits in der Liste.", "Crew");
      return;
    }
    const list = [...draft.crew_list];
    if (crewEditIndex == null) {
      list.push({
        name,
        tandemmaster: true,
        videospringer: false,
      });
    } else {
      const prev = list[crewEditIndex];
      list[crewEditIndex] = {
        name,
        tandemmaster: prev?.tandemmaster ?? true,
        videospringer: prev?.videospringer ?? false,
      };
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    patch("crew_list", list);
    resetCrewForm();
  }

  function patchCrewRole(
    index: number,
    role: "tandemmaster" | "videospringer",
    value: boolean,
  ) {
    if (!draft) return;
    const list = draft.crew_list.map((m, i) =>
      i === index ? { ...m, [role]: value } : m,
    );
    const updated = list[index];
    if (updated && !updated.tandemmaster && !updated.videospringer) {
      showError("Mindestens eine Rolle muss aktiv sein.", "Crew");
      return;
    }
    patch("crew_list", list);
  }

  function deleteCrewMember(index: number) {
    if (!draft) return;
    const member = draft.crew_list[index];
    if (!member) return;
    if (!window.confirm(`„${member.name}“ aus der Crew-Liste entfernen?`)) return;
    patch(
      "crew_list",
      draft.crew_list.filter((_, i) => i !== index),
    );
    if (crewEditIndex === index) resetCrewForm();
    else if (crewEditIndex != null && crewEditIndex > index) {
      setCrewEditIndex(crewEditIndex - 1);
    }
  }

  async function pickFolder(
    key: "speicherort" | "sd_backup_folder" | "sd_server_backup_path",
  ) {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") patch(key, selected);
  }

  async function onSave() {
    if (!draft) return;
    if (draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
      showError("Bitte einen Backup-Ordner wählen.");
      return;
    }
    if (
      draft.sd_server_backup_enabled &&
      !draft.sd_server_backup_path.trim()
    ) {
      showError("Bitte einen zweiten Backup-Ordner wählen oder die Option deaktivieren.");
      return;
    }
    if (
      draft.keep_tandemmaster_on_session_reset &&
      !draft.tandemmaster.trim()
    ) {
      showError("Bitte einen Tandemmaster wählen oder anlegen.");
      return;
    }
    if (
      draft.keep_videospringer_on_session_reset &&
      !draft.videospringer.trim()
    ) {
      showError("Bitte einen Videospringer wählen oder anlegen.");
      return;
    }
    let crew_list = [...draft.crew_list];
    const tm = draft.tandemmaster.trim();
    const vs = draft.videospringer.trim();
    if (draft.keep_tandemmaster_on_session_reset && tm) {
      crew_list = ensureCrewRole(crew_list, tm, "tandemmaster");
    }
    if (draft.keep_videospringer_on_session_reset && vs) {
      crew_list = ensureCrewRole(crew_list, vs, "videospringer");
    }
    crew_list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    const toSave: AppConfig = {
      ...draft,
      tandemmaster: draft.keep_tandemmaster_on_session_reset ? tm : "",
      videospringer: draft.keep_videospringer_on_session_reset ? vs : "",
      sd_pc_name: draft.sd_pc_name.trim(),
      crew_list,
    };
    const saved = await persist(toSave);
    if (saved) {
      showSuccess("Einstellungen wurden gespeichert.");
      onOpenChange(false);
    } else {
      showError("Einstellungen konnten nicht gespeichert werden.");
    }
  }

  async function onResetDefaults() {
    if (
      !window.confirm(
        "Alle Einstellungen auf die Werkseinstellungen zurücksetzen?\n\nSpeicherort, Server-Zugangsdaten und individuelle Anpassungen gehen verloren.",
      )
    ) {
      return;
    }
    const restored = await resetToDefaults();
    if (restored) {
      const list = [...(restored.crew_list ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, "de"),
      );
      setDraft({ ...restored, crew_list: list });
      setCrewDraft({ name: "", tandemmaster: true, videospringer: false });
      setCrewEditIndex(null);
      showSuccess("Einstellungen wurden auf die Standardeinstellungen zurückgesetzt.");
      onOpenChange(false);
      onAfterFactoryReset?.();
    } else {
      showError("Standardeinstellungen konnten nicht wiederhergestellt werden.");
    }
  }

  async function onApplyVersion() {
    if (!selectedRelease) return;
    if (selectedRelease.tag_name === appVersion) return;
    if (
      !window.confirm(
        `Zu Version ${selectedRelease.tag_name} wechseln?\n\nDer Installer wird heruntergeladen und gestartet. Die App sollte danach neu gestartet werden.`,
      )
    ) {
      return;
    }
    setInstallingVersion(true);
    try {
      const msg = await installSpecificVersion(selectedRelease.installer_url);
      showSuccess(msg, "Update");
      onOpenChange(false);
    } catch (e) {
      showError(String(e), "Update");
    } finally {
      setInstallingVersion(false);
    }
  }

  function formatReleaseDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("de-DE", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(85vh,42rem)] max-w-2xl flex-col gap-4 overflow-hidden"
        onPointerDownOutside={(e) => {
          if (suppressDismiss) e.preventDefault();
        }}
        onFocusOutside={(e) => {
          if (suppressDismiss) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (suppressDismiss) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (suppressDismiss) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Einstellungen</DialogTitle>
          <DialogDescription className="sr-only">
            App-Einstellungen bearbeiten
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="allgemein" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TabsList className="flex h-auto shrink-0 flex-wrap gap-1">
            <TabsTrigger value="allgemein">Allgemein</TabsTrigger>
            <TabsTrigger value="crew">Crew</TabsTrigger>
            <TabsTrigger value="qr">QR-Code</TabsTrigger>
            <TabsTrigger value="encoding">Encoding</TabsTrigger>
            <TabsTrigger value="sd">SD / Backup</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <TabsContent value="allgemein" className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label>Speicherort</Label>
              <div className="flex gap-2">
                <Input value={draft.speicherort} readOnly placeholder="Ordner wählen…" />
                <Button type="button" variant="secondary" onClick={() => pickFolder("speicherort")}>
                  Wählen…
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Intro-Dauer (Sek.)</Label>
                <Select
                  value={String(draft.dauer)}
                  onValueChange={(v) => patch("dauer", Number(v))}
                  disabled={!draft.intro_enabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Combobox
                  label="Ort (Standard)"
                  value={draft.ort}
                  onChange={(v) => patch("ort", v)}
                  options={ORT_OPTIONS}
                  placeholder="Ort…"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.intro_enabled}
                onCheckedChange={(v) => patch("intro_enabled", v === true)}
              />
              Intro beim Erstellen verwenden
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="manual-entry-mode">Manueller Eingabemodus</Label>
              <Select
                value={normalizeManualEntryMode(
                  draft.manual_entry_mode,
                  draft.oldschool_mode,
                )}
                onValueChange={(v) => {
                  const mode = normalizeManualEntryMode(v) as ManualEntryMode;
                  setDraft((prev) =>
                    prev ? withManualEntryMode(prev, mode) : prev,
                  );
                }}
              >
                <SelectTrigger id="manual-entry-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="id">ID (Kunden-/Booking-ID)</SelectItem>
                  <SelectItem value="oldschool">
                    Oldschool (Name + E-Mail/Telefon)
                  </SelectItem>
                  <SelectItem value="lokal">
                    Lokal (Name, ohne _fertig.txt)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-card-elevated/40 p-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.keep_tandemmaster_on_session_reset}
                  onCheckedChange={(v) => {
                    const on = v === true;
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            keep_tandemmaster_on_session_reset: on,
                            tandemmaster: on ? prev.tandemmaster : "",
                          }
                        : prev,
                    );
                  }}
                />
                Tandemmaster beim Zurücksetzen beibehalten
              </label>
              {draft.keep_tandemmaster_on_session_reset ? (
                <Combobox
                  label="Tandemmaster"
                  value={draft.tandemmaster}
                  onChange={(v) => patch("tandemmaster", v)}
                  options={tandemmasterOptions}
                  placeholder="Name wählen oder neu eintippen…"
                  listZIndex={100}
                />
              ) : null}

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.keep_videospringer_on_session_reset}
                  onCheckedChange={(v) => {
                    const on = v === true;
                    setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            keep_videospringer_on_session_reset: on,
                            videospringer: on ? prev.videospringer : "",
                          }
                        : prev,
                    );
                  }}
                />
                Videospringer beim Zurücksetzen beibehalten
              </label>
              {draft.keep_videospringer_on_session_reset ? (
                <Combobox
                  label="Videospringer"
                  value={draft.videospringer}
                  onChange={(v) => patch("videospringer", v)}
                  options={videospringerOptions}
                  placeholder="Name wählen oder neu eintippen…"
                  listZIndex={100}
                />
              ) : null}
            </div>

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
                />
              </div>
              <div className="space-y-1.5">
                <Label>Passwort</Label>
                <Input
                  type="password"
                  value={draft.server_password}
                  onChange={(e) => patch("server_password", e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={testingServer}
                onClick={async () => {
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
                }}
              >
                {testingServer ? "Prüfe…" : "Verbindung testen"}
              </Button>
              <span className="text-xs text-muted">
                {serverPhase === "connected"
                  ? "✓ Verbunden"
                  : serverPhase === "error"
                    ? "✗ Fehler"
                    : serverPhase === "checking"
                      ? "Prüfe…"
                      : "Nicht geprüft"}
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.upload_to_server}
                onCheckedChange={(v) => patch("upload_to_server", v === true)}
              />
              Nach Erstellung auf Server hochladen
            </label>

            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
              <Label>Cache & Temp</Label>
              <p className="text-xs text-muted">
                Entfernt Preview-/Concat-/Work-Ordner in Temp, Schnitt-Reste,
                bekannte Temp-Dateien und Arbeitsordner neben dem Speicherort.
                Leert außerdem die aktuelle Medien-Session (Working-Folder).
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={cleaningCache}
                onClick={async () => {
                  setCleaningCache(true);
                  try {
                    const importSnapshot = [...videoPaths, ...photoPaths];
                    clearVideos();
                    clearPhotos();
                    await clearWorkingSession();
                    const result = await cleanupCache({
                      speicherort: draft.speicherort || null,
                      import_paths: importSnapshot,
                      exclude_temp_dir: null,
                      include_hw_cache: false,
                      orphans_only: false,
                    });
                    showSuccess(result.summary, "Cache");
                  } catch (e) {
                    showError(String(e), "Cache");
                  } finally {
                    setCleaningCache(false);
                  }
                }}
              >
                {cleaningCache ? "Räume auf…" : "Cache leeren"}
              </Button>
            </div>

            <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Label>Update</Label>
                {appVersion ? (
                  <p className="text-xs text-muted">Version {appVersion}</p>
                ) : null}
              </div>
              <p className="text-xs text-muted">
                Beim Start wird automatisch nach neueren Versionen gesucht.
                Hier können Sie auch eine ältere oder neuere Version manuell
                auswählen.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onRequestUpdateCheck?.()}
                >
                  Nach Updates suchen
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={showPrereleases}
                    onCheckedChange={(v) => setShowPrereleases(v === true)}
                  />
                  Prereleases anzeigen
                </label>
              </div>

              <div className="space-y-1.5">
                <Label>Verfügbare Versionen</Label>
                <div className="flex flex-wrap gap-2">
                  <Select
                    value={selectedVersion || undefined}
                    onValueChange={setSelectedVersion}
                    disabled={releasesLoading || filteredReleases.length === 0}
                  >
                    <SelectTrigger className="min-w-[12rem] flex-1">
                      <SelectValue
                        placeholder={
                          releasesLoading
                            ? "Lade Versionen…"
                            : releasesError
                              ? "Nicht verfügbar"
                              : "Version wählen…"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredReleases.map((r) => {
                        const labels: string[] = [];
                        if (r.tag_name === appVersion) labels.push("Installiert");
                        if (r.prerelease) labels.push("Prerelease");
                        const suffix =
                          labels.length > 0 ? ` (${labels.join(", ")})` : "";
                        return (
                          <SelectItem key={r.tag_name} value={r.tag_name}>
                            {r.tag_name}
                            {suffix}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      installingVersion ||
                      !selectedRelease ||
                      selectedRelease.tag_name === appVersion
                    }
                    onClick={() => void onApplyVersion()}
                  >
                    {installingVersion ? "Lade…" : "Version übernehmen"}
                  </Button>
                </div>
                {releasesError ? (
                  <p className="text-xs text-destructive">{releasesError}</p>
                ) : null}
              </div>

              {selectedRelease ? (
                <div className="space-y-1 rounded-md border border-border/50 bg-card/40 p-3">
                  <p className="text-sm font-medium">
                    Version {selectedRelease.tag_name}
                    {selectedRelease.tag_name === appVersion
                      ? " (installiert)"
                      : ""}
                  </p>
                  {selectedRelease.published_at ? (
                    <p className="text-xs text-muted">
                      {formatReleaseDate(selectedRelease.published_at)}
                    </p>
                  ) : null}
                  <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-muted">
                    {selectedRelease.body || "Keine Release Notes."}
                  </pre>
                </div>
              ) : null}
            </div>

            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
              <Label>Zurücksetzen</Label>
              <p className="text-xs text-muted">
                Stellt alle Einstellungen auf die Werkseinstellungen zurück
                (inkl. Crew-Liste, Encoding, QR und SD). Wird sofort gespeichert.
              </p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={saving}
                onClick={() => void onResetDefaults()}
              >
                Auf Standardeinstellungen zurücksetzen
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="crew" className="mt-4 space-y-4">
            <div className="space-y-2 rounded-xl border border-border bg-card-elevated/60 p-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Springer / Crew</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Namen erscheinen je nach Rolle in den Comboboxen Tandemmaster und
                  Videospringer. Freitext im Formular bleibt weiterhin möglich.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input
                    value={crewDraft.name}
                    onChange={(e) =>
                      setCrewDraft((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="z. B. Andy"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveCrewMember();
                      }
                    }}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <Button type="button" onClick={saveCrewMember}>
                    {crewEditIndex == null ? (
                      <>
                        <Plus className="h-4 w-4" />
                        Hinzufügen
                      </>
                    ) : (
                      "Umbenennen"
                    )}
                  </Button>
                  {crewEditIndex != null ? (
                    <Button type="button" variant="secondary" onClick={resetCrewForm}>
                      Abbrechen
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="max-h-72 overflow-auto rounded-md border border-border">
              {sortedCrew.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted">
                  Noch keine Einträge — oben hinzufügen.
                </p>
              ) : (
                <>
                  <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border bg-card-elevated/95 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
                    <span>Name</span>
                    <span className="w-28 text-center">Tandemmaster</span>
                    <span className="w-28 text-center">Videospringer</span>
                    <span className="w-20 text-right">Aktion</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {sortedCrew.map(({ member, index }) => (
                      <li
                        key={`${member.name}-${index}`}
                        className={cn(
                          "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3 py-2",
                          crewEditIndex === index && "bg-primary-soft/40",
                        )}
                      >
                        <p className="truncate text-sm font-medium" title={member.name}>
                          {member.name}
                        </p>
                        <div className="flex w-28 justify-center">
                          <Checkbox
                            checked={member.tandemmaster}
                            onCheckedChange={(v) =>
                              patchCrewRole(index, "tandemmaster", v === true)
                            }
                            aria-label={`${member.name}: Tandemmaster`}
                          />
                        </div>
                        <div className="flex w-28 justify-center">
                          <Checkbox
                            checked={member.videospringer}
                            onCheckedChange={(v) =>
                              patchCrewRole(index, "videospringer", v === true)
                            }
                            aria-label={`${member.name}: Videospringer`}
                          />
                        </div>
                        <div className="flex w-20 justify-end gap-0.5">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            title="Umbenennen"
                            onClick={() => startEditCrew(index)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            title="Löschen"
                            onClick={() => deleteCrewMember(index)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="qr" className="mt-4 space-y-4">
            <div className="space-y-3 rounded-xl border border-border bg-card-elevated/60 p-4">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Auto-Scan beim Import
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Nach Drag & Drop, Dateiauswahl oder SD-Import werden neue Dateien
                  automatisch auf QR geprüft. Die Schalter stehen auch direkt unter der
                  Medien-Dropzone.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.qr_check_enabled}
                  onCheckedChange={(v) => patch("qr_check_enabled", v === true)}
                />
                Videos beim Import automatisch scannen
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.photo_qr_check_enabled}
                  onCheckedChange={(v) =>
                    patch("photo_qr_check_enabled", v === true)
                  }
                />
                Fotos beim Import automatisch scannen
              </label>
            </div>

            <div className="space-y-1.5">
              <Label>QR Video-Scan (Sekunden)</Label>
              <Input
                type="number"
                min={1}
                max={30}
                value={draft.qr_video_scan_seconds}
                onChange={(e) =>
                  patch("qr_video_scan_seconds", Math.max(1, Number(e.target.value) || 5))
                }
              />
              <p className="text-[11px] text-muted">
                Wie viele Sekunden vom Clip-Anfang (und parallele Offsets) gelesen werden.
              </p>
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-card-elevated/60 p-3">
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
                QR-Foto nach erfolgreicher Analyse entfernen
              </label>
              <p className="pl-6 text-[11px] leading-relaxed text-muted">
                Zusätzlich werden die nächsten 10 Fotos auf QR geprüft und bei Treffer
                ebenfalls entfernt.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.qr_remove_video_after_scan}
                  onCheckedChange={(v) =>
                    patch("qr_remove_video_after_scan", v === true)
                  }
                />
                QR-Videoclip nach erfolgreicher Analyse entfernen
              </label>
              <div
                className={
                  draft.qr_remove_video_after_scan
                    ? "space-y-1.5 pl-6"
                    : "pointer-events-none space-y-1.5 pl-6 opacity-50"
                }
              >
                <Label>Max. Clip-Länge für Löschung (Sek.)</Label>
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
                      Number.isFinite(n) ? Math.min(300, Math.max(1, Math.round(n))) : 10,
                    );
                  }}
                />
                <p className="text-[11px] text-muted">
                  Nur Clips mit dieser Länge oder kürzer werden entfernt (Standard: 10s).
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="encoding" className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label>Video-Codec</Label>
              <Select
                value={draft.video_codec}
                onValueChange={(v) => patch("video_codec", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (empfohlen)</SelectItem>
                  <SelectItem value="h264">H.264</SelectItem>
                  <SelectItem value="h265">H.265</SelectItem>
                  <SelectItem value="vp9">VP9</SelectItem>
                  <SelectItem value="av1">AV1</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Encoding-Strategie</Label>
              <Select
                value={draft.encoding_strategy}
                onValueChange={(v) => patch("encoding_strategy", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_clip">Pro Clip</SelectItem>
                  <SelectItem value="combined">Kombiniert</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Intro zusammenfügen</Label>
              <Select
                value={
                  draft.intro_mux_mode === "stream_copy"
                    ? "stream_copy"
                    : "reencode"
                }
                onValueChange={(v) => patch("intro_mux_mode", v)}
                disabled={!draft.intro_enabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reencode">
                    Neu kodieren (kompatibel)
                  </SelectItem>
                  <SelectItem value="stream_copy">
                    Stream-Copy (schnell)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Neu kodieren erzeugt Intro und Flugvideo als einen durchgängigen
                Bitstream — zuverlässig auf Handys und in Playern. Stream-Copy
                ist schneller, kann aber auf manchen Geräten einfrieren.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.hardware_acceleration_enabled}
                onCheckedChange={(v) =>
                  patch("hardware_acceleration_enabled", v === true)
                }
              />
              Hardware-Beschleunigung
            </label>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.parallel_processing_enabled}
                onCheckedChange={(v) =>
                  patch("parallel_processing_enabled", v === true)
                }
              />
              Paralleles Video-Processing
            </label>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.reencode_matching_clips}
                onCheckedChange={(v) => patch("reencode_matching_clips", v === true)}
              />
              Passende Clips neu encodieren
            </label>

            <div className="space-y-1.5">
              <Label>Preview CRF</Label>
              <Input
                type="number"
                min={0}
                max={51}
                value={draft.preview_encode_crf}
                onChange={(e) => patch("preview_encode_crf", Number(e.target.value) || 18)}
              />
            </div>
          </TabsContent>

          <TabsContent value="sd" className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label>Backup-Ordner</Label>
              <div className="flex gap-2">
                <Input value={draft.sd_backup_folder} readOnly placeholder="Ordner wählen…" />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => pickFolder("sd_backup_folder")}
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

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sd_server_backup_enabled}
                onCheckedChange={(v) => patch("sd_server_backup_enabled", v === true)}
              />
              Zusätzlich auf zweiten Pfad sichern
            </label>
            {draft.sd_server_backup_enabled ? (
              <>
                <div className="space-y-1.5">
                  <Label>Zweiter Backup-Ordner</Label>
                  <div className="flex gap-2">
                    <Input
                      value={draft.sd_server_backup_path}
                      readOnly
                      placeholder="Ordner wählen…"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => pickFolder("sd_server_backup_path")}
                    >
                      Wählen…
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Kopierstrategie (zweiter Pfad)</Label>
                  <Select
                    value={
                      draft.sd_server_backup_mode === "local_then_server"
                        ? "local_then_server"
                        : "direct_dual_write"
                    }
                    onValueChange={(v) => patch("sd_server_backup_mode", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct_dual_write">
                        Direkt: pro Datei SD → beide
                      </SelectItem>
                      <SelectItem value="local_then_server">
                        Spiegeln: erst lokal, dann → zweiter Pfad
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}

            <div className="space-y-1.5">
              <Label>Backup-Modus</Label>
              <Select
                value={draft.sd_backup_mode}
                onValueChange={(v) => patch("sd_backup_mode", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confirm">Vorher bestätigen</SelectItem>
                  <SelectItem value="auto">Automatisch</SelectItem>
                  <SelectItem value="disabled">Deaktiviert</SelectItem>
                </SelectContent>
              </Select>
            </div>

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
            <label
              className={`flex items-center gap-2 text-sm ${!draft.sd_auto_backup ? "opacity-50" : ""}`}
              title={
                draft.sd_auto_backup
                  ? "SD-Karte nach erfolgreichem Backup leeren"
                  : "Nur möglich, wenn Auto-Backup aktiviert ist"
              }
            >
              <Checkbox
                checked={draft.sd_clear_after_backup && draft.sd_auto_backup}
                disabled={!draft.sd_auto_backup}
                onCheckedChange={(v) => patch("sd_clear_after_backup", v === true)}
              />
              SD nach Backup leeren
            </label>
            <label
              className="flex items-center gap-2 text-sm"
              title="SD-Karte nach erfolgreichem Backup/Import sicher auswerfen"
            >
              <Checkbox
                checked={draft.sd_eject_after_workflow}
                onCheckedChange={(v) => patch("sd_eject_after_workflow", v === true)}
              />
              SD nach Workflow auswerfen
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sd_auto_import}
                onCheckedChange={(v) => patch("sd_auto_import", v === true)}
              />
              Auto-Import
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sd_skip_processed}
                onCheckedChange={(v) => patch("sd_skip_processed", v === true)}
              />
              Bereits verarbeitete Dateien überspringen
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sd_size_limit_enabled}
                onCheckedChange={(v) => patch("sd_size_limit_enabled", v === true)}
              />
              Größen-Limit aktivieren
            </label>
            <div className="space-y-1.5">
              <Label>Größen-Limit (MB)</Label>
              <Input
                type="number"
                min={1}
                value={draft.sd_size_limit_mb}
                disabled={!draft.sd_size_limit_enabled}
                onChange={(e) =>
                  patch("sd_size_limit_mb", Number(e.target.value) || 3000)
                }
              />
            </div>
            <p className="text-xs text-muted">
              Modus Auto und „Vorher bestätigen“: Backup / Import / Bereinigen / Auswerfen laut
              Schaltern. Bereinigen nur nach erfolgreichem Backup.
            </p>
          </TabsContent>
          </div>
        </Tabs>

        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-center text-xs text-muted sm:text-left">
            Aero Tandem Studio
            {appVersion ? ` v${appVersion}` : ""}
            {" · © Andreas Kowalenko"}
          </p>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
              Abbrechen
            </Button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Speichern…" : "Speichern"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
