import { useEffect, useMemo, useState } from "react";
import { tr } from "@/i18n";
import type { AvailableRelease } from "@/lib/tauri";
import { getAppInfo, listAvailableVersions } from "@/lib/tauri";
import { compareVersionParts, isVersionPrerelease } from "@/lib/versionCompare";

export function useReleaseList(open: boolean, betaUpdatesEnabled: boolean) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [releases, setReleases] = useState<AvailableRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("");

  const filteredReleases = useMemo(() => {
    if (betaUpdatesEnabled) return releases;
    return releases.filter((r) => !r.prerelease);
  }, [releases, betaUpdatesEnabled]);

  const installedIsBeta = useMemo(() => {
    if (!appVersion) return false;
    if (isVersionPrerelease(appVersion)) return true;
    return releases.some(
      (r) => r.prerelease && compareVersionParts(r.tag_name, appVersion) === 0,
    );
  }, [appVersion, releases]);

  const selectedRelease = useMemo(
    () => filteredReleases.find((r) => r.tag_name === selectedVersion) ?? null,
    [filteredReleases, selectedVersion],
  );

  const selectedRelation = useMemo(() => {
    if (!selectedRelease || !appVersion) return null;
    const cmp = compareVersionParts(selectedRelease.tag_name, appVersion);
    if (cmp > 0) return "newer" as const;
    if (cmp < 0) return "older" as const;
    return "same" as const;
  }, [selectedRelease, appVersion]);

  useEffect(() => {
    if (!open) return;
    void getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => setAppVersion(null));

    let cancelled = false;
    setReleasesLoading(true);
    setReleasesError(null);
    void listAvailableVersions()
      .then((list) => {
        if (cancelled) return;
        setReleases(list);
        const firstStable = list.find((r) => !r.prerelease);
        setSelectedVersion(firstStable?.tag_name ?? list[0]?.tag_name ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        setReleases([]);
        setSelectedVersion("");
        const raw = String(e);
        const looksTechnical =
          /error sending request|dns error|reqwest|os error|failed to lookup|timed out|connection refused/i.test(
            raw,
          );
        setReleasesError(
          looksTechnical
            ? tr("settings.system.update.releasesUnavailable")
            : raw,
        );
      })
      .finally(() => {
        if (!cancelled) setReleasesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || releases.length === 0) return;
    const visible = betaUpdatesEnabled
      ? releases
      : releases.filter((r) => !r.prerelease);
    if (appVersion && visible.some((r) => r.tag_name === appVersion)) {
      setSelectedVersion(appVersion);
      return;
    }
    setSelectedVersion((prev) =>
      visible.some((r) => r.tag_name === prev)
        ? prev
        : (visible[0]?.tag_name ?? ""),
    );
  }, [appVersion, open, releases, betaUpdatesEnabled]);

  function formatReleaseDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("de-DE", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function releaseRelationLabel(tag: string): "Installiert" | null {
    if (!appVersion) return null;
    if (compareVersionParts(tag, appVersion) === 0) return "Installiert";
    return null;
  }

  return {
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
  };
}
