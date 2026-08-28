import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import {
  measureCache,
  probeClearLocalBackupFolders,
  probeClearLocalJobFolders,
  type LocalFolderClearProbe,
} from "@/lib/tauri";
import type { AvailableRelease } from "@/lib/tauri";
import { formatBytes } from "@/lib/formatBytes";
import { useUiStore } from "@/store/uiStore";
import { useVideoStore } from "@/store/videoStore";
import { usePhotoStore } from "@/store/photoStore";
import { useAppendStore } from "@/store/appendStore";
import { useUploadQueueStore } from "@/store/uploadQueueStore";
import { useSdStore } from "@/store/sdStore";
import type { useReleaseList } from "../hooks/useReleaseList";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";
import { presentUpdaterInstallHint } from "@/lib/updaterInstallHint";
import { cn } from "@/lib/utils";

type ReleaseList = ReturnType<typeof useReleaseList>;

export type DangerClearConfirm =
  | {
      kind: "jobs";
      probe: LocalFolderClearProbe;
      includeOrphans: boolean;
    }
  | {
      kind: "backups";
      probe: LocalFolderClearProbe;
    };

type Props = SettingsTabBaseProps & {
  saving: boolean;
  sessionBusy?: boolean;
  /** Bumps after a successful Danger Zone clear so probes re-run. */
  dangerClearedNonce?: number;
  /** Bumps after cache clear so size re-measures. */
  cacheClearedNonce?: number;
  cacheClearing?: boolean;
  onRequestUpdateCheck?: (includeBeta: boolean) => void;
  onRequestReset: () => void;
  onRequestCacheClear: () => void;
  onRequestDangerConfirm: (confirm: DangerClearConfirm) => void;
  releaseList: ReleaseList;
  onRequestVersionSwitch?: (release: AvailableRelease) => void;
  installBlockedReason?: string | null;
  platformHint?: string | null;
};

type CacheSizeState =
  | { status: "measuring"; bytes?: number }
  | { status: "ok"; bytes: number }
  | { status: "error" };

type DangerProbeState =
  | { status: "idle" }
  | { status: "measuring"; probe?: LocalFolderClearProbe }
  | { status: "ok"; probe: LocalFolderClearProbe }
  | { status: "error" };

const REFRESH_SPIN_MIN_MS = 500;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Clear (left) + size value + bordered refresh (right), one row. */
function UsageActionRow({
  clearButton,
  value,
  measuring,
  failedHint,
  refreshLabel,
  onRefresh,
  refreshDisabled,
}: {
  clearButton: ReactNode;
  value: ReactNode;
  measuring: boolean;
  failedHint?: string | null;
  refreshLabel: string;
  onRefresh: () => void;
  refreshDisabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="shrink-0">{clearButton}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
        <span
          className="inline-flex h-8 min-w-[8rem] items-center justify-end font-medium tabular-nums"
          aria-live="polite"
          aria-busy={measuring}
          title={failedHint ?? undefined}
        >
          {value}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={refreshDisabled || measuring}
          onClick={onRefresh}
          aria-label={refreshLabel}
          title={refreshLabel}
        >
          <RefreshCw
            className={cn("size-3.5", measuring && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>
    </div>
  );
}

export function SystemTab({
  draft,
  patch,
  saving,
  sessionBusy = false,
  dangerClearedNonce = 0,
  cacheClearedNonce = 0,
  cacheClearing = false,
  onRequestUpdateCheck,
  onRequestReset,
  onRequestCacheClear,
  onRequestDangerConfirm,
  releaseList,
  onRequestVersionSwitch,
  installBlockedReason = null,
  platformHint = null,
}: Props) {
  const { t } = useTranslation();
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const videoList = useVideoStore((s) => s.videoList);
  const photoList = usePhotoStore((s) => s.photoList);
  const appendActive = useAppendStore((s) => s.active);
  const uploadHasWork = useUploadQueueStore(
    (s) => s.active !== null || s.queue.length > 0,
  );
  const sdBlocking = useSdStore(
    (s) =>
      s.workflowActive ||
      s.backupProgress !== null ||
      s.secondaryBackup !== null,
  );
  const [clearingDanger, setClearingDanger] = useState(false);
  const [includeOrphans, setIncludeOrphans] = useState(false);
  const [cacheSize, setCacheSize] = useState<CacheSizeState>({
    status: "measuring",
  });
  const [jobsProbe, setJobsProbe] = useState<DangerProbeState>({
    status: "idle",
  });
  const [backupsProbe, setBackupsProbe] = useState<DangerProbeState>({
    status: "idle",
  });
  const measureReqId = useRef(0);
  const jobsProbeReqId = useRef(0);
  const backupsProbeReqId = useRef(0);
  const videoPaths = useMemo(() => videoList.map((v) => v.path), [videoList]);
  const photoPaths = useMemo(() => photoList.map((p) => p.path), [photoList]);

  const clearBlocked =
    sessionBusy || appendActive || uploadHasWork || sdBlocking || clearingDanger;

  const speicherortSet = Boolean(draft.speicherort?.trim());
  const backupFolderSet = Boolean(draft.sd_backup_folder?.trim());

  const measureArgs = useMemo(
    () => ({
      speicherort: draft.speicherort || null,
      import_paths: [...videoPaths, ...photoPaths],
      exclude_temp_dir: null as string | null,
      include_hw_cache: false,
      orphans_only: false,
    }),
    [draft.speicherort, videoPaths, photoPaths],
  );

  const refreshCacheSize = async () => {
    const reqId = ++measureReqId.current;
    const started = Date.now();
    setCacheSize((prev) => ({
      status: "measuring",
      bytes:
        prev.status === "ok" || prev.status === "measuring"
          ? prev.bytes
          : undefined,
    }));
    try {
      const result = await measureCache(measureArgs);
      if (reqId !== measureReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== measureReqId.current) return;
      setCacheSize({ status: "ok", bytes: result.bytes });
    } catch {
      if (reqId !== measureReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== measureReqId.current) return;
      setCacheSize({ status: "error" });
    }
  };

  const refreshJobsProbe = async () => {
    const reqId = ++jobsProbeReqId.current;
    if (!speicherortSet) {
      setJobsProbe({ status: "idle" });
      return;
    }
    const started = Date.now();
    setJobsProbe((prev) => ({
      status: "measuring",
      probe:
        prev.status === "ok" || prev.status === "measuring"
          ? prev.probe
          : undefined,
    }));
    try {
      const probe = await probeClearLocalJobFolders({
        speicherort: draft.speicherort || null,
        include_orphans: includeOrphans,
      });
      if (reqId !== jobsProbeReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== jobsProbeReqId.current) return;
      setJobsProbe({ status: "ok", probe });
    } catch {
      if (reqId !== jobsProbeReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== jobsProbeReqId.current) return;
      setJobsProbe({ status: "error" });
    }
  };

  const refreshBackupsProbe = async () => {
    const reqId = ++backupsProbeReqId.current;
    if (!backupFolderSet) {
      setBackupsProbe({ status: "idle" });
      return;
    }
    const started = Date.now();
    setBackupsProbe((prev) => ({
      status: "measuring",
      probe:
        prev.status === "ok" || prev.status === "measuring"
          ? prev.probe
          : undefined,
    }));
    try {
      const probe = await probeClearLocalBackupFolders({
        sd_backup_folder: draft.sd_backup_folder || null,
      });
      if (reqId !== backupsProbeReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== backupsProbeReqId.current) return;
      setBackupsProbe({ status: "ok", probe });
    } catch {
      if (reqId !== backupsProbeReqId.current) return;
      const wait = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      if (reqId !== backupsProbeReqId.current) return;
      setBackupsProbe({ status: "error" });
    }
  };

  useEffect(() => {
    refreshCacheSize();
    return () => {
      measureReqId.current += 1;
    };
    // Measure when System tab mounts (Radix unmounts inactive TabsContent).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only + explicit refresh
  }, []);

  useEffect(() => {
    if (cacheClearedNonce === 0) return;
    void refreshCacheSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remeasure after parent clear
  }, [cacheClearedNonce]);

  useEffect(() => {
    refreshJobsProbe();
    return () => {
      jobsProbeReqId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path/orphans/clear nonce
  }, [draft.speicherort, includeOrphans, dangerClearedNonce]);

  useEffect(() => {
    refreshBackupsProbe();
    return () => {
      backupsProbeReqId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path/clear nonce
  }, [draft.sd_backup_folder, dangerClearedNonce]);

  const {
    appVersion,
    releasesLoading,
    releasesError,
    filteredReleases,
    selectedVersion,
    setSelectedVersion,
    selectedRelease,
    selectedRelation,
    installedIsBeta,
    formatReleaseDate,
    releaseRelationLabel,
  } = releaseList;

  const silentAvailable = Boolean(selectedRelease?.updater_json_url);
  const hasInstaller = Boolean(selectedRelease?.installer_url);
  const applyDisabled =
    !selectedRelease ||
    selectedRelation === "same" ||
    Boolean(installBlockedReason) ||
    (!silentAvailable && !hasInstaller);

  const applyLabel =
    !silentAvailable && hasInstaller
      ? t("settings.system.update.openInstaller")
      : selectedRelation === "older"
        ? t("settings.system.update.installOlder")
        : selectedRelation === "newer"
          ? t("settings.system.update.update")
          : t("settings.system.update.applyVersion");

  const busyHint = clearBlocked
    ? t("settings.system.danger.busyHint")
    : !speicherortSet || !backupFolderSet
      ? t("settings.system.danger.pathHint")
      : null;

  const requestClearJobs = async () => {
    if (clearBlocked || !speicherortSet) return;
    setClearingDanger(true);
    try {
      let probe: LocalFolderClearProbe;
      if (jobsProbe.status === "ok") {
        probe = jobsProbe.probe;
      } else {
        probe = await probeClearLocalJobFolders({
          speicherort: draft.speicherort || null,
          include_orphans: includeOrphans,
        });
        setJobsProbe({ status: "ok", probe });
      }
      if (probe.folder_count === 0 && probe.file_count === 0) {
        showSuccess(
          t("settings.system.danger.nothingToDelete"),
          t("settings.system.danger.toastTitle"),
        );
        return;
      }
      onRequestDangerConfirm({
        kind: "jobs",
        probe,
        includeOrphans,
      });
    } catch (e) {
      showError(String(e), t("settings.system.danger.toastTitle"));
    } finally {
      setClearingDanger(false);
    }
  };

  const requestClearBackups = async () => {
    if (clearBlocked || !backupFolderSet) return;
    setClearingDanger(true);
    try {
      let probe: LocalFolderClearProbe;
      if (backupsProbe.status === "ok") {
        probe = backupsProbe.probe;
      } else {
        probe = await probeClearLocalBackupFolders({
          sd_backup_folder: draft.sd_backup_folder || null,
        });
        setBackupsProbe({ status: "ok", probe });
      }
      if (probe.folder_count === 0 && probe.file_count === 0) {
        showSuccess(
          t("settings.system.danger.nothingToDelete"),
          t("settings.system.danger.toastTitle"),
        );
        return;
      }
      onRequestDangerConfirm({ kind: "backups", probe });
    } catch (e) {
      showError(String(e), t("settings.system.danger.toastTitle"));
    } finally {
      setClearingDanger(false);
    }
  };

  const formatDangerUsage = (probe: LocalFolderClearProbe) =>
    t("settings.system.danger.usageSummary", {
      size: formatBytes(probe.bytes),
      folders: probe.folder_count,
      files: probe.file_count,
    });

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.system.update.title")}
        description={t("settings.system.update.description")}
      >
        {appVersion ? (
          <p className="text-xs text-muted">
            {t("settings.system.update.installedVersion", {
              version: appVersion,
            })}
            {installedIsBeta ? (
              <span className="ml-1 font-medium text-amber-600 dark:text-amber-500">
                ({t("settings.system.update.beta")})
              </span>
            ) : null}
          </p>
        ) : null}
        {platformHint ? (
          <p className="text-xs text-muted">
            {presentUpdaterInstallHint(platformHint)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={Boolean(installBlockedReason)}
            onClick={() => onRequestUpdateCheck?.(draft.beta_updates_enabled)}
          >
            {t("settings.system.update.check")}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.beta_updates_enabled}
              onCheckedChange={(v) =>
                patch("beta_updates_enabled", v === true)
              }
            />
            {t("settings.system.update.betaTester")}
          </label>
        </div>
        <p className="text-xs text-muted">
          {t("settings.system.update.betaTesterDescription")}
        </p>

        <div className="space-y-1.5">
          <Label>{t("settings.system.update.availableVersions")}</Label>
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
                      ? t("settings.system.update.loadingVersions")
                      : releasesError
                        ? t("settings.system.update.unavailable")
                        : t("settings.system.update.chooseVersion")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {filteredReleases.map((r, index) => {
                  const labels: string[] = [];
                  if (index === 0) labels.push(t("settings.system.update.latest"));
                  const installed = releaseRelationLabel(r.tag_name);
                  if (installed) labels.push(t("settings.system.update.installed"));
                  if (r.prerelease) labels.push(t("settings.system.update.beta"));
                  if (!r.updater_json_url)
                    labels.push(t("settings.system.update.notAutoInstallable"));
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
              disabled={applyDisabled}
              onClick={() => {
                if (!selectedRelease) return;
                onRequestVersionSwitch?.(selectedRelease);
              }}
            >
              {applyLabel}
            </Button>
          </div>
          {releasesError ? (
            <p className="text-xs text-muted">{releasesError}</p>
          ) : null}
          {installBlockedReason ? (
            <p className="text-xs text-destructive">{installBlockedReason}</p>
          ) : null}
          {selectedRelease &&
          selectedRelation !== "same" &&
          !selectedRelease.updater_json_url ? (
            <p className="text-xs text-muted">
              {t("settings.system.update.noAutoInstall")}
            </p>
          ) : null}
        </div>

        {selectedRelease ? (
          <div className="space-y-1 rounded-md border border-border/50 bg-card/40 p-3">
            <p className="text-sm font-medium">
              {t("settings.system.update.versionHeading", {
                version: selectedRelease.tag_name,
              })}
            </p>
            {selectedRelease.published_at ? (
              <p className="text-xs text-muted">
                {formatReleaseDate(selectedRelease.published_at)}
              </p>
            ) : null}
            <ReleaseNotes
              markdown={selectedRelease.body}
              emptyLabel={t("settings.system.update.noNotes")}
              className="max-h-40"
            />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t("settings.system.cache.title")}
        description={t("settings.system.cache.description")}
      >
        <UsageActionRow
          clearButton={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={cacheClearing}
              onClick={onRequestCacheClear}
            >
              {cacheClearing
                ? t("settings.system.cache.cleaning")
                : t("settings.system.cache.clear")}
            </Button>
          }
          value={
            cacheSize.status === "ok" ||
            (cacheSize.status === "measuring" && cacheSize.bytes != null) ? (
              <>
                {formatBytes(
                  cacheSize.status === "ok"
                    ? cacheSize.bytes
                    : (cacheSize.bytes ?? 0),
                )}
                {cacheSize.status === "measuring" ? (
                  <span className="sr-only">
                    {t("settings.system.cache.measuring")}
                  </span>
                ) : null}
              </>
            ) : cacheSize.status === "measuring" ? (
              <span className="sr-only">
                {t("settings.system.cache.measuring")}
              </span>
            ) : (
              <span
                className="text-muted"
                title={t("settings.system.cache.measureFailed")}
              >
                —
              </span>
            )
          }
          measuring={cacheSize.status === "measuring"}
          failedHint={
            cacheSize.status === "error"
              ? t("settings.system.cache.measureFailed")
              : null
          }
          refreshLabel={t("settings.system.cache.refresh")}
          onRefresh={() => void refreshCacheSize()}
          refreshDisabled={cacheClearing}
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.system.reset.title")}
        description={t("settings.system.reset.description")}
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={saving}
          onClick={onRequestReset}
        >
          {t("settings.system.reset.button")}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t("settings.system.danger.title")}
        description={t("settings.system.danger.description")}
        className={cn("border-destructive/60")}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs text-muted break-all">
              {speicherortSet
                ? draft.speicherort
                : t("settings.folder.noneSet")}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeOrphans}
                disabled={clearBlocked || !speicherortSet}
                onCheckedChange={(v) => setIncludeOrphans(v === true)}
              />
              {t("settings.system.danger.includeOrphans")}
            </label>
            <UsageActionRow
              clearButton={
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={clearBlocked || !speicherortSet || clearingDanger}
                  onClick={() => void requestClearJobs()}
                >
                  {t("settings.system.danger.clearJobs")}
                </Button>
              }
              value={
                !speicherortSet ? (
                  <span className="text-muted">—</span>
                ) : jobsProbe.status === "ok" ||
                  (jobsProbe.status === "measuring" && jobsProbe.probe) ? (
                  <>
                    {formatDangerUsage(
                      jobsProbe.status === "ok"
                        ? jobsProbe.probe
                        : jobsProbe.probe!,
                    )}
                    {jobsProbe.status === "measuring" ? (
                      <span className="sr-only">
                        {t("settings.system.danger.measuring")}
                      </span>
                    ) : null}
                  </>
                ) : jobsProbe.status === "measuring" ? (
                  <span className="sr-only">
                    {t("settings.system.danger.measuring")}
                  </span>
                ) : jobsProbe.status === "error" ? (
                  <span
                    className="text-muted"
                    title={t("settings.system.danger.measureFailed")}
                  >
                    —
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )
              }
              measuring={speicherortSet && jobsProbe.status === "measuring"}
              failedHint={
                jobsProbe.status === "error"
                  ? t("settings.system.danger.measureFailed")
                  : null
              }
              refreshLabel={t("settings.system.danger.refresh")}
              onRefresh={() => void refreshJobsProbe()}
              refreshDisabled={
                clearingDanger || !speicherortSet || clearBlocked
              }
            />
          </div>

          <div className="space-y-2 border-t border-border/60 pt-3">
            <p className="text-xs text-muted break-all">
              {backupFolderSet
                ? draft.sd_backup_folder
                : t("settings.folder.noneSet")}
            </p>
            <UsageActionRow
              clearButton={
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={
                    clearBlocked || !backupFolderSet || clearingDanger
                  }
                  onClick={() => void requestClearBackups()}
                >
                  {t("settings.system.danger.clearBackups")}
                </Button>
              }
              value={
                !backupFolderSet ? (
                  <span className="text-muted">—</span>
                ) : backupsProbe.status === "ok" ||
                  (backupsProbe.status === "measuring" &&
                    backupsProbe.probe) ? (
                  <>
                    {formatDangerUsage(
                      backupsProbe.status === "ok"
                        ? backupsProbe.probe
                        : backupsProbe.probe!,
                    )}
                    {backupsProbe.status === "measuring" ? (
                      <span className="sr-only">
                        {t("settings.system.danger.measuring")}
                      </span>
                    ) : null}
                  </>
                ) : backupsProbe.status === "measuring" ? (
                  <span className="sr-only">
                    {t("settings.system.danger.measuring")}
                  </span>
                ) : backupsProbe.status === "error" ? (
                  <span
                    className="text-muted"
                    title={t("settings.system.danger.measureFailed")}
                  >
                    —
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )
              }
              measuring={
                backupFolderSet && backupsProbe.status === "measuring"
              }
              failedHint={
                backupsProbe.status === "error"
                  ? t("settings.system.danger.measureFailed")
                  : null
              }
              refreshLabel={t("settings.system.danger.refresh")}
              onRefresh={() => void refreshBackupsProbe()}
              refreshDisabled={
                clearingDanger || !backupFolderSet || clearBlocked
              }
            />
          </div>

          {busyHint ? (
            <p className="text-xs text-muted">{busyHint}</p>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}
