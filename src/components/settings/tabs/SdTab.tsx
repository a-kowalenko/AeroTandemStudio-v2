import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { FolderPathField } from "../FolderPathField";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function SdTab({ draft, patch, setDraft }: SettingsTabBaseProps) {
  const showError = useUiStore((s) => s.showError);

  async function pickFolder(
    key: "sd_backup_folder" | "sd_server_backup_path",
  ) {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") patch(key, selected);
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Backup"
        description="SD-Karten-Backups und optionaler zweiter Zielpfad."
      >
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

        <div
          className={cn("space-y-3", !draft.sd_auto_backup && "opacity-50")}
        >
          <FolderPathField
            label="Backup-Ordner"
            value={draft.sd_backup_folder}
            disabled={!draft.sd_auto_backup}
            onPick={() => void pickFolder("sd_backup_folder")}
            onOpenError={(message) => showError(message, "Ordner")}
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
              Wird im Backup-Ordnernamen verwendet, z.B. SD_Backup_…[
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
              checked={draft.sd_clear_after_backup && draft.sd_auto_backup}
              disabled={!draft.sd_auto_backup}
              onCheckedChange={(v) => patch("sd_clear_after_backup", v === true)}
            />
            SD nach Backup leeren
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_server_backup_enabled}
            onCheckedChange={(v) => patch("sd_server_backup_enabled", v === true)}
          />
          Zusätzlich auf zweiten Pfad sichern
        </label>
        {draft.sd_server_backup_enabled ? (
          <div className="space-y-3 pl-1">
            <FolderPathField
              label="Zweiter Backup-Ordner"
              value={draft.sd_server_backup_path}
              onPick={() => void pickFolder("sd_server_backup_path")}
              onOpenError={(message) => showError(message, "Ordner")}
            />
            <div className="space-y-1.5">
              <Label>Kopierstrategie (zweiter Pfad)</Label>
              <Select
                value={
                  draft.sd_server_backup_mode === "local_then_server"
                    ? "local_then_server"
                    : draft.sd_server_backup_mode === "local_then_server_async"
                      ? "local_then_server_async"
                      : "direct_dual_write"
                }
                onValueChange={(v) => patch("sd_server_backup_mode", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local_then_server_async">
                    Hintergrund: lokal fertig → Server parallel
                  </SelectItem>
                  <SelectItem value="local_then_server">
                    Spiegeln: erst lokal, dann warten → zweiter Pfad
                  </SelectItem>
                  <SelectItem value="direct_dual_write">
                    Direkt: pro Datei SD → beide
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted">
                Empfohlen für Netzwerkziele: Hintergrund — der Workflow wartet
                nicht auf den zweiten Pfad.
              </p>
            </div>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Import & Auswerfen"
        description="Automatischer Import nach Backup; Auswerfen sobald die SD nicht mehr benötigt wird."
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_auto_import}
            onCheckedChange={(v) => patch("sd_auto_import", v === true)}
          />
          Auto-Import
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Nach dem Backup passende Medien automatisch in die Session laden.
        </p>
        <label
          className="flex items-center gap-2 text-sm"
          title="Nach Backup sofort auswerfen (Import/QR danach von Kopien). Ohne Backup: nach dem Import."
        >
          <Checkbox
            checked={draft.sd_eject_after_workflow}
            onCheckedChange={(v) => patch("sd_eject_after_workflow", v === true)}
          />
          SD automatisch auswerfen
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Mit Backup direkt danach; ohne Backup erst nach dem Import.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_skip_processed}
            onCheckedChange={(v) => patch("sd_skip_processed", v === true)}
          />
          Bereits verarbeitete Dateien überspringen
        </label>
      </SettingsSection>

      <SettingsSection
        title="Warnschwelle"
        description="Bestätigung, wenn die SD-Karte ein Größenlimit überschreitet."
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_size_limit_enabled}
            onCheckedChange={(v) => patch("sd_size_limit_enabled", v === true)}
          />
          Größen-Limit aktivieren
        </label>
        <div
          className={cn(
            "space-y-1.5 pl-1",
            !draft.sd_size_limit_enabled && "pointer-events-none opacity-50",
          )}
        >
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
      </SettingsSection>

      <p className="text-xs text-muted">
        Modus Auto und „Vorher bestätigen“: Backup / Import / Bereinigen /
        Auswerfen laut Schaltern. Bereinigen nur nach erfolgreichem Backup.
      </p>
    </div>
  );
}
