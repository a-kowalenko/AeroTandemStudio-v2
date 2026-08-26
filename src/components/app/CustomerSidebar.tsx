import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CloudOff,
  CloudUpload,
  ExternalLink,
  FolderOpen,
  RotateCcw,
} from "lucide-react";
import { CustomerForm, CustomerSessionStrip } from "../CustomerForm";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useConfigStore } from "../../store/configStore";
import { useKundeStore } from "../../store/kundeStore";
import { usePhotoStore } from "../../store/photoStore";
import { useVideoStore } from "../../store/videoStore";
import { useServerStore } from "../../store/serverStore";
import { useUiStore } from "../../store/uiStore";
import { useQrScanStore } from "../../store/qrScanStore";
import { focusCreateReadyTarget } from "../../lib/createReadyHints";
import { cn } from "../../lib/utils";
import type { useCreateValidation } from "../../hooks/useCreateValidation";

type CreateValidation = ReturnType<typeof useCreateValidation>;

type Props = {
  busy: boolean;
  appendActive: boolean;
  sdWorkflowUiActive: boolean;
  pipelineActive: boolean;
  onStartCreate: () => void;
  setMediaTab: (tab: "video" | "foto") => void;
  createValidation: CreateValidation;
  onEnsureSpeicherort: (forcePick?: boolean) => Promise<string | null>;
  onOpenSpeicherortFolder: () => void;
};

export function CustomerSidebar({
  busy,
  appendActive,
  sdWorkflowUiActive,
  pipelineActive,
  onStartCreate,
  setMediaTab,
  createValidation,
  onEnsureSpeicherort,
  onOpenSpeicherortFolder,
}: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const persistConfig = useConfigStore((s) => s.persist);
  const kunde = useKundeStore((s) => s.kunde);
  const videoImporting = useVideoStore((s) => s.importing);
  const photoImporting = usePhotoStore((s) => s.importing);
  const serverConnected = useServerStore((s) => s.connected);
  const loading = useUiStore((s) => s.loading);
  const qrScanBusy = useQrScanStore((s) => s.busy);

  const {
    createReady,
    createBanner,
    createReadyPulse,
    setCreateReadyPulse,
  } = createValidation;

  const uiLocked =
    busy ||
    appendActive ||
    sdWorkflowUiActive ||
    loading ||
    qrScanBusy ||
    videoImporting ||
    photoImporting;

  const customerFormLocked =
    busy || (kunde.form_mode === "kunde" && pipelineActive);
  const sessionStripLocked = busy;
  const formModeToggleLocked = busy || pipelineActive;

  const uploadIntentOn = Boolean(config?.upload_to_server);
  const uploadActive = Boolean(uploadIntentOn && serverConnected);
  const uploadBlocked = Boolean(uploadIntentOn && !serverConnected);
  const uploadNudge = serverConnected && !uploadIntentOn;
  const autoClearAfterCreate = Boolean(config?.auto_clear_files_after_creation);
  const uploadTitle = uploadBlocked
    ? t("app.upload.titleBlockedOn")
    : !serverConnected
      ? t("app.upload.titleBlockedOff")
      : uploadActive
        ? t("app.upload.titleActive")
        : t("app.upload.titleOff");
  const createUploadLater = uploadBlocked;
  const createUploadNow = uploadActive;
  return (
    <aside className="ats-sidebar-bg flex w-full max-w-md flex-col border-r border-border backdrop-blur-md sm:w-[400px]">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="border-b border-border/40 px-3 pt-1.5 pb-1.5">
          <CustomerSessionStrip disabled={sessionStripLocked} />
        </div>
        <div className="p-4">
          <CustomerForm
            disabled={customerFormLocked}
            crewDisabled={busy}
            modeToggleDisabled={formModeToggleLocked}
          />
        </div>
      </div>

      <div className="flex flex-col border-t border-border bg-gradient-to-t from-card/90 to-card/40 p-3.5 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {t("app.job.section")}
          </p>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <label
              htmlFor="vorgang-upload"
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                uploadActive
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : uploadBlocked
                    ? "border-warning/40 bg-warning/10 text-warning"
                    : uploadNudge
                      ? "border-destructive bg-destructive/20 text-destructive"
                      : "border-border bg-card-elevated/80 text-muted",
                (uiLocked || !config) && "cursor-not-allowed",
              )}
              title={uploadTitle}
            >
              {uploadBlocked ? (
                <CloudOff className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" aria-hidden />
              )}
              {uploadBlocked
                ? t("app.upload.titleLater")
                : t("app.upload.title")}
              <Switch
                id="vorgang-upload"
                className={cn(
                  "h-4 w-7 [&_span]:h-3 [&_span]:w-3 [&_span]:data-[state=checked]:translate-x-3",
                  uploadBlocked &&
                    "data-[state=checked]:bg-warning disabled:opacity-80",
                )}
                checked={uploadIntentOn}
                disabled={uiLocked || !config}
                onCheckedChange={(v) => {
                  if (!config) return;
                  void persistConfig({
                    ...config,
                    upload_to_server: v === true,
                  });
                }}
                aria-label={t("app.job.uploadAria")}
              />
            </label>
            <label
              htmlFor="vorgang-clear"
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                autoClearAfterCreate
                  ? "border-primary/30 bg-primary/5 text-foreground/80"
                  : "border-border bg-card-elevated/80 text-muted",
                (uiLocked || !config) && "cursor-not-allowed",
              )}
              title={t("app.job.clearTitle")}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t("app.job.clear")}
              <Switch
                id="vorgang-clear"
                className="h-4 w-7 [&_span]:h-3 [&_span]:w-3 [&_span]:data-[state=checked]:translate-x-3"
                checked={autoClearAfterCreate}
                disabled={uiLocked || !config}
                onCheckedChange={(v) => {
                  if (!config) return;
                  void persistConfig({
                    ...config,
                    auto_clear_files_after_creation: v === true,
                  });
                }}
                aria-label={t("app.job.clearTitle")}
              />
            </label>
          </div>
        </div>
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            createBanner ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {createBanner ? (
              <div
                className="mt-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-warning"
                role="status"
                aria-live="polite"
              >
                <div
                  className={cn(
                    "flex gap-2",
                    createBanner.items.length === 1
                      ? "items-center"
                      : "items-start",
                  )}
                >
                  <AlertTriangle
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      createBanner.items.length > 1 && "mt-0.5",
                    )}
                    aria-hidden
                  />
                  <div
                    className={cn(
                      "min-w-0",
                      createBanner.showChips && "space-y-1",
                    )}
                  >
                    {createBanner.items.length === 1 &&
                    createBanner.items[0].target !== "none" ? (
                      <button
                        type="button"
                        className="text-left text-xs font-medium leading-snug hover:underline"
                        onClick={() =>
                          focusCreateReadyTarget(
                            createBanner.items[0].target,
                            { setMediaTab },
                          )
                        }
                      >
                        {createBanner.headline}
                      </button>
                    ) : (
                      <p className="text-xs font-medium leading-snug">
                        {createBanner.headline}
                      </p>
                    )}
                    {createBanner.showChips ? (
                      <div className="flex flex-wrap gap-1">
                        {createBanner.items.map((item) => (
                          <button
                            key={item.label}
                            type="button"
                            className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium leading-snug text-warning hover:bg-warning/20"
                            aria-label={t("app.ready.showTarget", { label: item.label })}
                            onClick={() =>
                              focusCreateReadyTarget(item.target, {
                                setMediaTab,
                              })
                            }
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="mt-2.5 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="shrink-0"
            onClick={() => void onEnsureSpeicherort(true)}
            disabled={uiLocked}
            title={t("app.storage.change")}
            aria-label={t("app.storage.change")}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="shrink-0"
            onClick={() => void onOpenSpeicherortFolder()}
            disabled={uiLocked || !config?.speicherort?.trim()}
            title={t("settings.folder.openInExplorer")}
            aria-label={t("settings.folder.openInExplorer")}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <div className="relative flex-1 overflow-visible">
            {createReadyPulse ? (
              <span
                aria-hidden
                className="ats-create-ready-halo pointer-events-none absolute inset-0 rounded-md"
              />
            ) : null}
            <Button
              type="button"
              className={cn(
                "relative z-[1] w-full gap-1.5",
                createReadyPulse && "ats-create-ready-flash",
              )}
              onClick={onStartCreate}
              disabled={uiLocked || !createReady}
              onAnimationEnd={(e) => {
                if (
                  e.target === e.currentTarget &&
                  e.animationName === "ats-create-ready-lift"
                ) {
                  setCreateReadyPulse(false);
                }
              }}
              title={
                createUploadNow
                  ? t("app.job.createUploadTitle")
                  : createUploadLater
                    ? t("app.job.createUploadLaterTitle")
                    : undefined
              }
            >
              {createUploadNow ? (
                <>
                  <CloudUpload className="h-4 w-4" aria-hidden />
                  {t("common.actions.createAndUpload")}
                </>
              ) : createUploadLater ? (
                <>
                  <CloudOff className="h-4 w-4" aria-hidden />
                  {t("common.actions.createAndUploadLater")}
                </>
              ) : (
                t("common.actions.create")
              )}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
