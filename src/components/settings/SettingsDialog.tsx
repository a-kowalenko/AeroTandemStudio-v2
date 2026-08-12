import { useEffect, useState } from "react";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestUpdateCheck?: () => void;
  onAfterFactoryReset?: () => void;
  suppressDismiss?: boolean;
};

const TAB_ITEMS: { value: SettingsTab; label: string }[] = [
  { value: "allgemein", label: "Allgemein" },
  { value: "crew", label: "Crew" },
  { value: "qr", label: "QR-Code" },
  { value: "encoding", label: "Video" },
  { value: "sd", label: "SD / Backup" },
  { value: "server", label: "Server" },
  { value: "system", label: "System" },
];

export function SettingsDialog({
  open,
  onOpenChange,
  onRequestUpdateCheck,
  onAfterFactoryReset,
  suppressDismiss = false,
}: Props) {
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
  const releaseList = useReleaseList(open);
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
      !window.confirm(
        "Ungespeicherte Änderungen verwerfen?",
      )
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
                !window.confirm("Ungespeicherte Änderungen verwerfen?")
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
            <DialogTitle>Einstellungen</DialogTitle>
            <DialogDescription className="sr-only">
              App-Einstellungen bearbeiten
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={settingsTab}
            onValueChange={(v) => setSettingsTab(v as SettingsTab)}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <TabsList className="flex h-auto shrink-0 flex-wrap gap-1">
              {TAB_ITEMS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
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
                  onVersionApplied={() => onOpenChange(false)}
                />
              </TabsContent>
            </div>
          </Tabs>

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-center text-xs text-muted sm:text-left">
              Aero Tandem Studio
              {releaseList.appVersion ? ` v${releaseList.appVersion}` : ""}
              {" · © Andreas Kowalenko"}
            </p>
            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                variant="secondary"
                onClick={requestClose}
                disabled={saving}
              >
                Abbrechen
              </Button>
              <Button onClick={() => void onSave()} disabled={saving}>
                {saving ? "Speichern…" : "Speichern"}
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
              Standardeinstellungen wiederherstellen?
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              Alle Einstellungen werden auf die Werkseinstellungen zurückgesetzt.
              {"\n\n"}
              Speicherort, Server-Zugangsdaten und individuelle Anpassungen gehen
              verloren.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setResetConfirmOpen(false)}
            >
              Abbrechen
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={() => void onResetDefaults()}
            >
              Zurücksetzen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
