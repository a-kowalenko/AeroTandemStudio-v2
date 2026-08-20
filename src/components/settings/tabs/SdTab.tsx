import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        title={t("settings.sd.backup.title")}
        description={t("settings.sd.backup.description")}
      >
        <div className="space-y-1.5">
          <Label>{t("settings.sd.backup.mode")}</Label>
          <Select
            value={draft.sd_backup_mode}
            onValueChange={(v) => patch("sd_backup_mode", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="confirm">
                {t("settings.sd.backup.modeConfirm")}
              </SelectItem>
              <SelectItem value="auto">{t("settings.sd.backup.modeAuto")}</SelectItem>
              <SelectItem value="disabled">
                {t("settings.sd.backup.modeDisabled")}
              </SelectItem>
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
          {t("settings.sd.backup.auto")}
        </label>

        <div
          className={cn("space-y-3", !draft.sd_auto_backup && "opacity-50")}
        >
          <FolderPathField
            label={t("settings.sd.backup.folder")}
            value={draft.sd_backup_folder}
            disabled={!draft.sd_auto_backup}
            onPick={() => void pickFolder("sd_backup_folder")}
            onOpenError={(message) =>
              showError(message, t("settings.folder.toastTitle"))
            }
          />
          <div className="space-y-1.5">
            <Label>{t("settings.sd.backup.pcName")}</Label>
            <Input
              value={draft.sd_pc_name}
              placeholder={t("settings.sd.backup.pcNamePlaceholder")}
              disabled={!draft.sd_auto_backup}
              onChange={(e) => patch("sd_pc_name", e.target.value)}
            />
            <p className="text-xs text-muted">
              {t("settings.sd.backup.pcNameHint", {
                name: draft.sd_pc_name.trim() || t("settings.sd.backup.pcNameFallback"),
              })}
            </p>
          </div>
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
              checked={draft.sd_clear_after_backup && draft.sd_auto_backup}
              disabled={!draft.sd_auto_backup}
              onCheckedChange={(v) => patch("sd_clear_after_backup", v === true)}
            />
            {t("settings.sd.backup.clearAfter")}
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_server_backup_enabled}
            onCheckedChange={(v) => patch("sd_server_backup_enabled", v === true)}
          />
          {t("settings.sd.backup.secondPath")}
        </label>
        {draft.sd_server_backup_enabled ? (
          <div className="space-y-3 pl-1">
            <FolderPathField
              label={t("settings.sd.backup.secondFolder")}
              value={draft.sd_server_backup_path}
              onPick={() => void pickFolder("sd_server_backup_path")}
              onOpenError={(message) =>
                showError(message, t("settings.folder.toastTitle"))
              }
            />
            <div className="space-y-1.5">
              <Label>{t("settings.sd.backup.copyStrategy")}</Label>
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
                    {t("settings.sd.backup.copyAsync")}
                  </SelectItem>
                  <SelectItem value="local_then_server">
                    {t("settings.sd.backup.copyMirror")}
                  </SelectItem>
                  <SelectItem value="direct_dual_write">
                    {t("settings.sd.backup.copyDirect")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted">
                {t("settings.sd.backup.copyHint")}
              </p>
            </div>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t("settings.sd.import.title")}
        description={t("settings.sd.import.description")}
      >
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
        <label
          className="flex items-center gap-2 text-sm"
          title={t("settings.sd.import.ejectTitle")}
        >
          <Checkbox
            checked={draft.sd_eject_after_workflow}
            onCheckedChange={(v) => patch("sd_eject_after_workflow", v === true)}
          />
          {t("settings.sd.import.eject")}
        </label>
        <p className="text-[11px] leading-snug text-muted">
          {t("settings.sd.import.ejectHint")}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_skip_processed}
            onCheckedChange={(v) => patch("sd_skip_processed", v === true)}
          />
          {t("settings.sd.import.skipProcessed")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.usb_camera_import_enabled}
            onCheckedChange={(v) =>
              patch("usb_camera_import_enabled", v === true)
            }
          />
          {t("settings.sd.import.usbCameras")}
        </label>
        <p className="text-[11px] leading-snug text-muted">
          {t("settings.sd.import.usbCamerasHint")}
        </p>
      </SettingsSection>

      <SettingsSection
        title={t("settings.sd.size.title")}
        description={t("settings.sd.size.description")}
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.sd_size_limit_enabled}
            onCheckedChange={(v) => patch("sd_size_limit_enabled", v === true)}
          />
          {t("settings.sd.size.enable")}
        </label>
        <div
          className={cn(
            "space-y-1.5 pl-1",
            !draft.sd_size_limit_enabled && "pointer-events-none opacity-50",
          )}
        >
          <Label>{t("settings.sd.size.limitMb")}</Label>
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

      <p className="text-xs text-muted">{t("settings.sd.footer")}</p>
    </div>
  );
}
