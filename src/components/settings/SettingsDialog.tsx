import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useCrewEditor } from "./hooks/useCrewEditor";
import { useReleaseList } from "./hooks/useReleaseList";
import { useSettingsDraft } from "./hooks/useSettingsDraft";
import { CrewTab } from "./tabs/CrewTab";
import { EncodingTab } from "./tabs/EncodingTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { QrTab } from "./tabs/QrTab";
import { SdTab } from "./tabs/SdTab";
import { ServerTab } from "./tabs/ServerTab";
import { SystemTab } from "./tabs/SystemTab";
import type { AvailableRelease } from "@/lib/tauri";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestUpdateCheck?: (includeBeta: boolean) => void;
  onRequestVersionSwitch?: (release: AvailableRelease) => void;
  installBlockedReason?: string | null;
  platformHint?: string | null;
  onAfterFactoryReset?: () => void;
  suppressDismiss?: boolean;
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
}: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
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
  const [flashFocus, setFlashFocus] = useState<SettingsFocusTarget | null>(null);

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

  if (!draft) return null;

  const tabProps = { draft, patch, setDraft };

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
          }
          onOpenChange(v);
        }}
      >
        <DialogContent
          className="flex h-[min(85vh,42rem)] max-w-2xl flex-col gap-4 overflow-visible"
          onPointerDownOutside={(e) => {
            const t = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              resetConfirmOpen ||
              t?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            const t = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              resetConfirmOpen ||
              t?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onInteractOutside={(e) => {
            const t = e.target as HTMLElement | null;
            if (
              suppressDismiss ||
              resetConfirmOpen ||
              t?.closest?.("[data-ats-combobox-list]")
            ) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (suppressDismiss || resetConfirmOpen) e.preventDefault();
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
                  onRequestUpdateCheck={onRequestUpdateCheck}
                  onRequestReset={() => setResetConfirmOpen(true)}
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
                disabled={saving || suppressDismiss}
              >
                {t("common.actions.cancel")}
              </Button>
              <Button
                onClick={() => void onSave()}
                disabled={saving || suppressDismiss}
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
              {t("common.actions.cancel")}
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
    </>
  );
}
