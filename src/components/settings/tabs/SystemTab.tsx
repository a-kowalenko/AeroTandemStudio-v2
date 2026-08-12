import { useMemo, useState } from "react";
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
import { cleanupCache, clearWorkingSession } from "@/lib/tauri";
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
  onVersionApplied?: () => void;
};

export function SystemTab({
  draft,
  saving,
  onRequestUpdateCheck,
  onRequestReset,
  releaseList,
  onVersionApplied,
}: Props) {
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
    showPrereleases,
    setShowPrereleases,
    installingVersion,
    applyVersion,
    formatReleaseDate,
  } = releaseList;

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Cache & Temp"
        description="Entfernt Preview-/Concat-/Work-Ordner in Temp, Schnitt-Reste, bekannte Temp-Dateien und Arbeitsordner neben dem Speicherort. Leert außerdem die aktuelle Medien-Session (Working-Folder)."
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
      </SettingsSection>

      <SettingsSection
        title="Update"
        description="Beim Start wird automatisch nach neueren Versionen gesucht. Hier können Sie auch eine ältere oder neuere Version manuell auswählen."
      >
        {appVersion ? (
          <p className="text-xs text-muted">Installierte Version: {appVersion}</p>
        ) : null}
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
              onClick={() => void applyVersion(onVersionApplied)}
            >
              {installingVersion ? "Lade…" : "Version übernehmen"}
            </Button>
          </div>
          {releasesError ? (
            <p className="text-xs text-muted">{releasesError}</p>
          ) : null}
        </div>

        {selectedRelease && selectedRelease.tag_name !== appVersion ? (
          <div className="space-y-1 rounded-md border border-border/50 bg-card/40 p-3">
            <p className="text-sm font-medium">
              Version {selectedRelease.tag_name}
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
      </SettingsSection>

      <SettingsSection
        title="Zurücksetzen"
        description="Stellt alle Einstellungen auf die Werkseinstellungen zurück (inkl. Crew-Liste, Encoding, QR und SD). Wird sofort gespeichert."
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={saving}
          onClick={onRequestReset}
        >
          Auf Standardeinstellungen zurücksetzen
        </Button>
      </SettingsSection>
    </div>
  );
}
