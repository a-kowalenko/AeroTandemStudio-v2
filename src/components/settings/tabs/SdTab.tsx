import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUiStore } from "@/store/uiStore";
import { useServerStore } from "@/store/serverStore";
import { presentServerConnectionAction } from "@/lib/headerConnectionStatus";
import {
  displayServerProfileLabel,
  getActiveServerProfile,
} from "@/lib/serverProfile";
import { cn } from "@/lib/utils";
import { FolderPathField } from "../FolderPathField";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

function looksLikeMountPath(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (lower.startsWith("smb://")) return false;
  if (t.startsWith("\\\\") || t.startsWith("//")) return false;
  if (t.length >= 2 && /^[a-zA-Z]:/.test(t)) return true;
  return t.startsWith("/");
}

function activeProfileBackupTarget(draft: SettingsTabBaseProps["draft"]) {
  const profile = getActiveServerProfile(draft);
  const url = profile?.backup_url?.trim() ?? "";
  const login =
    profile?.backup_login?.trim() || draft.server_login || "";
  const password =
    (profile?.backup_password ?? "") || draft.server_password || "";
  return { profile, url, login, password };
}

export function SdTab({ draft, patch, setDraft }: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const openSettings = useUiStore((s) => s.openSettings);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const [testingBackupUrl, setTestingBackupUrl] = useState(false);

  const backupTarget = activeProfileBackupTarget(draft);
  const profileBackupUrl = backupTarget.url;

  async function pickFolder(key: "sd_backup_folder") {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") patch(key, selected);
  }

  async function onTestBackupUrl() {
    if (testingBackupUrl || !profileBackupUrl) return;
    setTestingBackupUrl(true);
    try {
      const result = await checkConnection({
        server_url: profileBackupUrl,
        server_login: backupTarget.login,
        server_password: backupTarget.password,
      });
      const action = presentServerConnectionAction({
        ok: result.ok,
        rawMessage: result.message,
        serverUrl: profileBackupUrl,
        login: backupTarget.login,
        password: backupTarget.password,
      });
      if (result.ok) {
        showSuccess("", t("header.connection.titleServerOk"), {
          actions: [action],
          autoCloseSecs: 3,
        });
      } else {
        showSuccess("", t("header.connection.titleFailed"), {
          actions: [action],
        });
      }
    } finally {
      setTestingBackupUrl(false);
    }
  }

  function goToServerBackupUrl() {
    openSettings({ tab: "server", focus: "server-backup-url" });
  }

  const modeValue =
    draft.sd_server_backup_mode === "local_then_server"
      ? "local_then_server"
      : "local_then_server_async";

  const showMountHint =
    draft.sd_server_backup_enabled && looksLikeMountPath(profileBackupUrl);

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
            <div className="space-y-1.5">
              <Label>{t("settings.sd.backup.serverUrl")}</Label>
              {profileBackupUrl ? (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={profileBackupUrl}
                      readOnly
                      className="flex-1"
                      title={
                        backupTarget.profile
                          ? displayServerProfileLabel(backupTarget.profile)
                          : undefined
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={testingBackupUrl}
                      onClick={() => void onTestBackupUrl()}
                    >
                      {testingBackupUrl
                        ? t("settings.sd.backup.serverUrlTesting")
                        : t("settings.sd.backup.serverUrlTest")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted">
                    {t("settings.sd.backup.serverUrlFromProfile", {
                      name: backupTarget.profile
                        ? displayServerProfileLabel(backupTarget.profile)
                        : t("settings.tabs.server"),
                    })}{" "}
                    <button
                      type="button"
                      className="text-foreground underline-offset-2 hover:underline"
                      onClick={goToServerBackupUrl}
                    >
                      {t("settings.sd.backup.editInServerProfile")}
                    </button>
                  </p>
                </>
              ) : (
                <div className="space-y-2 rounded-md border border-dashed border-border/80 bg-background/40 px-3 py-2.5">
                  <p className="text-sm text-muted">
                    {t("settings.sd.backup.serverUrlMissing")}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={goToServerBackupUrl}
                  >
                    {t("settings.sd.backup.setInServerProfile")}
                  </Button>
                </div>
              )}
              {showMountHint ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t("settings.sd.backup.serverUrlMountWarn")}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.sd.backup.copyStrategy")}</Label>
              <Select
                value={modeValue}
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
        <div
          className={cn(
            "space-y-1.5 pl-1",
            !draft.usb_camera_import_enabled && "pointer-events-none opacity-50",
          )}
        >
          <Label>{t("settings.sd.import.usbImportMode")}</Label>
          <Select
            value={
              draft.usb_import_mode === "volume_only"
                ? "volume_only"
                : draft.usb_import_mode === "mtp_preferred"
                  ? "mtp_preferred"
                  : "auto"
            }
            disabled={!draft.usb_camera_import_enabled}
            onValueChange={(v) => patch("usb_import_mode", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {t("settings.sd.import.usbImportModeAuto")}
              </SelectItem>
              <SelectItem value="volume_only">
                {t("settings.sd.import.usbImportModeVolume")}
              </SelectItem>
              <SelectItem value="mtp_preferred">
                {t("settings.sd.import.usbImportModeMtp")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted">
            {t("settings.sd.import.usbImportModeHint")}
          </p>
        </div>
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
