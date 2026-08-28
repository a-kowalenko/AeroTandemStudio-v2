import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { useConfigStore } from "@/store/configStore";
import {
  useUiStore,
  type SettingsFocusTarget,
  type SettingsTab,
} from "@/store/uiStore";
import { useHistoryStore } from "@/store/historyStore";
import { useCrewEditor } from "./hooks/useCrewEditor";
import { useReleaseList } from "./hooks/useReleaseList";
import { useSettingsDraft } from "./hooks/useSettingsDraft";
import { CrewTab } from "./tabs/CrewTab";
import { EncodingTab } from "./tabs/EncodingTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { QrTab } from "./tabs/QrTab";
import { SdTab } from "./tabs/SdTab";
import { ServerTab } from "./tabs/ServerTab";
import {
  SystemTab,
  type DangerClearConfirm,
} from "./tabs/SystemTab";
import {
  clearLocalBackupFolders,
  clearLocalJobFolders,
  cleanupCache,
  clearWorkingSession,
  type AvailableRelease,
} from "@/lib/tauri";
import { presentCacheCleanupSummary } from "@/lib/cacheCleanupMessages";
import { formatBytes } from "@/lib/formatBytes";
import {
  folderMissingMapFromProbe,
  probeItemsFromVorgaenge,
  probeVorgangFolders,
} from "@/lib/vorgangFolderProbe";
import { useVideoStore } from "@/store/videoStore";
import { usePhotoStore } from "@/store/photoStore";
/** Strip Windows `\\?\` extended-length prefix for display / Explorer. */
function displayFsPath(path: string): string {
  const p = path.trim();
  if (p.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
  }
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  if (p.startsWith("//?/")) return p.slice(4);
  return p;
}
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestUpdateCheck?: (includeBeta: boolean) => void;
  onRequestVersionSwitch?: (release: AvailableRelease) => void;
  installBlockedReason?: string | null;
  platformHint?: string | null;
  onAfterFactoryReset?: () => void;
  suppressDismiss?: boolean;
  /** Create / encode / export in progress (App local busy). */
  sessionBusy?: boolean;
};

const TAB_ITEMS: { value: SettingsTab; labelKey: string }[] = [
  { value: "allgemein", labelKey: "settings.tabs.general" },
  { value: "crew", labelKey: "settings.tabs.crew" },
  { value: "qr", labelKey: "settings.tabs.qr" },
  { value: "encoding", labelKey: "settings.tabs.encoding" },
  { value: "sd", labelKey: "settings.tabs.sd" },
  { value: "server", labelKey: "settings.tabs.server" },
  { value: "system", labelKey: "settings.tabs.system" },
];

export function SettingsDialog({
  open,
  onOpenChange,
  onRequestUpdateCheck,
  onRequestVersionSwitch,
  installBlockedReason = null,
  platformHint = null,
  onAfterFactoryReset,
  suppressDismiss = false,
  sessionBusy = false,
}: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const settingsTab = useUiStore((s) => s.settingsTab);
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  const settingsFocus = useUiStore((s) => s.settingsFocus);
  const settingsFocusNonce = useUiStore((s) => s.settingsFocusNonce);
  const clearSettingsFocus = useUiStore((s) => s.clearSettingsFocus);

  const {
    draft,
    setDraft,
    patch,
    save,
    resetToFactory,
    saving,
    hasUnsavedChanges,
  } = useSettingsDraft(open, config);
  const releaseList = useReleaseList(open, draft?.beta_updates_enabled ?? false);
  const crewEditor = useCrewEditor({
    draft: draft ?? config,
    patch,
    setDraft,
  });

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [cacheConfirmOpen, setCacheConfirmOpen] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheClearedNonce, setCacheClearedNonce] = useState(0);
  const [dangerConfirm, setDangerConfirm] = useState<DangerClearConfirm | null>(
    null,
  );
  const [dangerClearing, setDangerClearing] = useState(false);
  const [dangerClearedNonce, setDangerClearedNonce] = useState(0);
  const [flashFocus, setFlashFocus] = useState<SettingsFocusTarget | null>(null);

  const softConfirmOpen =
    resetConfirmOpen || cacheConfirmOpen || dangerConfirm !== null;

  useEffect(() => {
    if (open) {
      crewEditor.resetCrewForm();
    }
  }, [open, config]); // reset crew form when dialog opens

  useEffect(() => {
    if (!open || !settingsFocus || !draft) return;

    if (settingsTab !== "server") {
      setSettingsTab("server");
    }

    const target = settingsFocus;
    setFlashFocus(target);

    const clearFlash = window.setTimeout(() => {
      setFlashFocus((current) => (current === target ? null : current));
      clearSettingsFocus();
    }, 2400);

    return () => {
      window.clearTimeout(clearFlash);
    };
  }, [
    open,
    draft,
    settingsFocus,
    settingsFocusNonce,
    clearSettingsFocus,
    setSettingsTab,
    settingsTab,
  ]);

  function requestClose() {
    if (
      hasUnsavedChanges &&
      !window.confirm(t("common.unsavedChangesDiscard"))
    ) {
      return;
    }
    onOpenChange(false);
  }

  async function onSave() {
    const saved = await save();
    if (saved) onOpenChange(false);
  }

  async function onResetDefaults() {
    setResetConfirmOpen(false);
    const restored = await resetToFactory();
    if (restored) {
      crewEditor.resetCrewForm();
      onOpenChange(false);
      onAfterFactoryReset?.();
    }
  }

  async function runCacheClear() {
    if (!draft) return;
    setCacheClearing(true);
    setCacheConfirmOpen(false);
    try {
      const videos = useVideoStore.getState();
      const photos = usePhotoStore.getState();
      const importSnapshot = [
        ...videos.videoList.map((v) => v.path),
        ...photos.photoList.map((p) => p.path),
      ];
      videos.clearVideos({ deleteFiles: false });
      photos.clearPhotos({ deleteFiles: false });
      await clearWorkingSession();
      const result = await cleanupCache({
        speicherort: draft.speicherort || null,
        import_paths: importSnapshot,
        exclude_temp_dir: null,
        include_hw_cache: false,
        orphans_only: false,
      });
      showSuccess(
        presentCacheCleanupSummary(result),
        t("settings.system.cache.toastTitle"),
      );
      setCacheClearedNonce((n) => n + 1);
    } catch (e) {
      showError(String(e), t("settings.system.cache.toastTitle"));
    } finally {
      setCacheClearing(false);
    }
  }

  function onRequestCacheClear() {
    const hasSession =
      useVideoStore.getState().videoList.length > 0 ||
      usePhotoStore.getState().photoList.length > 0;
    if (hasSession) {
      setCacheConfirmOpen(true);
      return;
    }
    void runCacheClear();
  }

  async function refreshFolderMissingAfterClear() {
    const { vorgaenge, vorgaengeLoaded, setFolderMissingById } =
      useHistoryStore.getState();
    if (!vorgaengeLoaded || vorgaenge.length === 0) return;
    try {
      setFolderMissingById(
        folderMissingMapFromProbe(
          await probeVorgangFolders(probeItemsFromVorgaenge(vorgaenge)),
        ),
      );
    } catch {
      // Best-effort; Historie dialog re-probes on open.
    }
  }

  async function onConfirmDangerClear() {
    if (!dangerConfirm || !draft) return;
    setDangerClearing(true);
    try {
      if (dangerConfirm.kind === "jobs") {
        const result = await clearLocalJobFolders({
          speicherort: draft.speicherort || null,
          include_orphans: dangerConfirm.includeOrphans,
        });
        showSuccess(
          presentCacheCleanupSummary(result),
          t("settings.system.danger.toastTitle"),
        );
        await refreshFolderMissingAfterClear();
      } else {
        const result = await clearLocalBackupFolders({
          sd_backup_folder: draft.sd_backup_folder || null,
        });
        showSuccess(
          presentCacheCleanupSummary(result),
          t("settings.system.danger.toastTitle"),
        );
      }
      setDangerConfirm(null);
      setDangerClearedNonce((n) => n + 1);
    } catch (e) {
      showError(String(e), t("settings.system.danger.toastTitle"));
    } finally {
      setDangerClearing(false);
    }
  }

  if (!draft) return null;

  const tabProps = { draft, patch, setDraft };

  const dangerFolderPath =
    dangerConfirm == null
      ? ""
      : displayFsPath(
          dangerConfirm.kind === "jobs"
            ? dangerConfirm.probe.root || draft.speicherort
            : dangerConfirm.probe.root || draft.sd_backup_folder,
        );

  const dangerBody =
    dangerConfirm == null
      ? ""
      : dangerConfirm.kind === "jobs"
        ? [
            t("settings.system.danger.confirmJobsBody", {
              folders: dangerConfirm.probe.folder_count,
              files: dangerConfirm.probe.file_count,
              size: formatBytes(dangerConfirm.probe.bytes),
            }),
            dangerConfirm.probe.retryable_upload_count > 0
              ? t("settings.system.danger.confirmUploadWarn", {
                  count: dangerConfirm.probe.retryable_upload_count,
                })
              : null,
          ]
            .filter(Boolean)
            .join("\n\n")
        : t("settings.system.danger.confirmBackupsBody", {
            folders: dangerConfirm.probe.folder_count,
            files: dangerConfirm.probe.file_count,
            size: formatBytes(dangerConfirm.probe.bytes),
          });

  async function openDangerFolder() {
    const path = dangerFolderPath.trim();
    if (!path) {
      showError(t("settings.folder.noneSet"), t("settings.folder.toastTitle"));
      return;
    }
    try {
      await revealItemInDir(path);
    } catch (e) {
      showError(String(e), t("settings.folder.toastTitle"));
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            if (hasUnsavedChanges) {
              if (
                !window.confirm(t("common.unsavedChangesDiscard"))
              ) {
                return;
              }
            }
            setResetConfirmOpen(false);
            setCacheConfirmOpen(false);
            setDangerConfirm(null);
          }
          onOpenChange(v);
        }}
      >
        <DialogContent
          className="flex h-[min(85vh,42rem)] max-w-2xl flex-col gap-4 overflow-visible"
          onPointerDownOutside={(e) => {
            const el = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              softConfirmOpen ||
              el?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            const el = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              softConfirmOpen ||
              el?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onInteractOutside={(e) => {
            const el = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              softConfirmOpen ||
              el?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (suppressDismiss || softConfirmOpen) e.preventDefault();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("settings.dialog.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.dialog.description")}
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={settingsTab}
            onValueChange={(v) => setSettingsTab(v as SettingsTab)}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <TabsList className="flex h-auto shrink-0 flex-wrap gap-1">
              {TAB_ITEMS.map(({ value, labelKey }) => (
                <TabsTrigger key={value} value={value}>
                  {t(labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-1 pr-5 [scrollbar-gutter:stable]">
              <TabsContent value="allgemein" className="mt-4">
                <GeneralTab {...tabProps} />
              </TabsContent>
              <TabsContent value="crew" className="mt-4">
                <CrewTab {...tabProps} crewEditor={crewEditor} />
              </TabsContent>
              <TabsContent value="qr" className="mt-4">
                <QrTab {...tabProps} />
              </TabsContent>
              <TabsContent value="encoding" className="mt-4">
                <EncodingTab {...tabProps} />
              </TabsContent>
              <TabsContent value="sd" className="mt-4">
                <SdTab {...tabProps} />
              </TabsContent>
              <TabsContent value="server" className="mt-4">
                <ServerTab {...tabProps} flashFocus={flashFocus} />
              </TabsContent>
              <TabsContent value="system" className="mt-4">
                <SystemTab
                  {...tabProps}
                  saving={saving}
                  sessionBusy={sessionBusy}
                  dangerClearedNonce={dangerClearedNonce}
                  cacheClearedNonce={cacheClearedNonce}
                  cacheClearing={cacheClearing}
                  onRequestUpdateCheck={onRequestUpdateCheck}
                  onRequestReset={() => setResetConfirmOpen(true)}
                  onRequestCacheClear={onRequestCacheClear}
                  onRequestDangerConfirm={setDangerConfirm}
                  releaseList={releaseList}
                  onRequestVersionSwitch={onRequestVersionSwitch}
                  installBlockedReason={installBlockedReason}
                  platformHint={platformHint}
                />
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-center text-xs text-muted sm:text-left">
              {t("settings.dialog.footer", {
                version: releaseList.appVersion
                  ? ` v${releaseList.appVersion}`
                  : "",
              })}
            </p>
            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                variant="secondary"
                onClick={requestClose}
                disabled={saving || suppressDismiss || dangerClearing || cacheClearing}
              >
                {t("common.actions.cancel")}
              </Button>
              <Button
                onClick={() => void onSave()}
                disabled={saving || suppressDismiss || dangerClearing || cacheClearing}
              >
                {saving ? t("common.actions.saving") : t("common.actions.save")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent
          className="z-[60] max-w-md border-l-4 border-l-destructive"
          overlayClassName="z-[60]"
        >
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {t("settings.system.reset.confirmTitle")}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {t("settings.system.reset.confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setResetConfirmOpen(false)}
            >
              {t("common.actions.back")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={() => void onResetDefaults()}
            >
              {t("common.actions.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cacheConfirmOpen}
        onOpenChange={(v) => {
          if (!v && !cacheClearing) setCacheConfirmOpen(false);
        }}
      >
        <DialogContent
          className="z-[60] max-w-md border-l-4 border-l-destructive"
          overlayClassName="z-[60]"
        >
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {t("settings.system.cache.confirmTitle")}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {t("settings.system.cache.confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={cacheClearing}
              onClick={() => setCacheConfirmOpen(false)}
            >
              {t("common.actions.back")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={cacheClearing}
              onClick={() => void runCacheClear()}
            >
              {cacheClearing
                ? t("settings.system.cache.cleaning")
                : t("settings.system.cache.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dangerConfirm !== null}
        onOpenChange={(v) => {
          if (!v && !dangerClearing) setDangerConfirm(null);
        }}
      >
        <DialogContent
          className="z-[60] max-w-md border-l-4 border-l-destructive"
          overlayClassName="z-[60]"
        >
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {dangerConfirm?.kind === "backups"
                ? t("settings.system.danger.confirmBackupsTitle")
                : t("settings.system.danger.confirmJobsTitle")}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {dangerBody}
            </DialogDescription>
          </DialogHeader>
          {dangerFolderPath ? (
            <p className="text-xs break-all text-muted">{dangerFolderPath}</p>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mr-auto"
              disabled={dangerClearing || !dangerFolderPath}
              onClick={() => void openDangerFolder()}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("settings.system.danger.openFolder")}
            </Button>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={dangerClearing}
                onClick={() => setDangerConfirm(null)}
              >
                {t("common.actions.back")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={dangerClearing}
                onClick={() => void onConfirmDangerClear()}
              >
                {dangerClearing
                  ? t("settings.system.danger.clearing")
                  : t("settings.system.danger.confirmProceed")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
