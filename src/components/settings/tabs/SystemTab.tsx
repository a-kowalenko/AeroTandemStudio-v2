import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { cleanupCache, clearWorkingSession } from "@/lib/tauri";
import type { AvailableRelease } from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";
import { useVideoStore } from "@/store/videoStore";
import { usePhotoStore } from "@/store/photoStore";
import type { useReleaseList } from "../hooks/useReleaseList";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type ReleaseList = ReturnType<typeof useReleaseList>;

type Props = SettingsTabBaseProps & {
  saving: boolean;
  onRequestUpdateCheck?: () => void;
  onRequestReset: () => void;
  releaseList: ReleaseList;
  onRequestVersionSwitch?: (release: AvailableRelease) => void;
  installBlockedReason?: string | null;
  platformHint?: string | null;
};

export function SystemTab({
  draft,
  saving,
  onRequestUpdateCheck,
  onRequestReset,
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
  const clearVideos = useVideoStore((s) => s.clearVideos);
  const clearPhotos = usePhotoStore((s) => s.clearPhotos);
  const [cleaningCache, setCleaningCache] = useState(false);
  const videoPaths = useMemo(() => videoList.map((v) => v.path), [videoList]);
  const photoPaths = useMemo(() => photoList.map((p) => p.path), [photoList]);

  const {
    appVersion,
    releasesLoading,
    releasesError,
    filteredReleases,
    selectedVersion,
    setSelectedVersion,
    selectedRelease,
    selectedRelation,
    showPrereleases,
    setShowPrereleases,
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

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.system.cache.title")}
        description={t("settings.system.cache.description")}
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={cleaningCache}
          onClick={async () => {
            setCleaningCache(true);
            try {
              const importSnapshot = [...videoPaths, ...photoPaths];
              clearVideos({ deleteFiles: false });
              clearPhotos({ deleteFiles: false });
              await clearWorkingSession();
              const result = await cleanupCache({
                speicherort: draft.speicherort || null,
                import_paths: importSnapshot,
                exclude_temp_dir: null,
                include_hw_cache: false,
                orphans_only: false,
              });
              showSuccess(result.summary, t("settings.system.cache.toastTitle"));
            } catch (e) {
              showError(String(e), t("settings.system.cache.toastTitle"));
            } finally {
              setCleaningCache(false);
            }
          }}
        >
          {cleaningCache
            ? t("settings.system.cache.cleaning")
            : t("settings.system.cache.clear")}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t("settings.system.update.title")}
        description={t("settings.system.update.description")}
      >
        {appVersion ? (
          <p className="text-xs text-muted">
            {t("settings.system.update.installedVersion", { version: appVersion })}
          </p>
        ) : null}
        {platformHint ? (
          <p className="text-xs text-muted">{platformHint}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={Boolean(installBlockedReason)}
            onClick={() => onRequestUpdateCheck?.()}
          >
            {t("settings.system.update.check")}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={showPrereleases}
              onCheckedChange={(v) => setShowPrereleases(v === true)}
            />
            {t("settings.system.update.showPrereleases")}
          </label>
        </div>

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
                  if (r.prerelease) labels.push(t("settings.system.update.prerelease"));
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
    </div>
  );
}
