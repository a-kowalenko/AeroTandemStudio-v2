import { useEffect, useMemo, useState } from "react";
import type { AvailableRelease } from "@/lib/tauri";
import { getAppInfo, installSpecificVersion, listAvailableVersions } from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";

export function useReleaseList(open: boolean) {
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [releases, setReleases] = useState<AvailableRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [showPrereleases, setShowPrereleases] = useState(false);
  const [installingVersion, setInstallingVersion] = useState(false);

  const filteredReleases = useMemo(() => {
    if (showPrereleases) return releases;
    return releases.filter((r) => !r.prerelease);
  }, [releases, showPrereleases]);

  const selectedRelease = useMemo(
    () => filteredReleases.find((r) => r.tag_name === selectedVersion) ?? null,
    [filteredReleases, selectedVersion],
  );

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
            ? "Versionsliste nicht verfügbar — bitte Internetverbindung prüfen."
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
    const visible = showPrereleases
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
  }, [appVersion, open, releases, showPrereleases]);

  async function applyVersion(onSuccess?: () => void) {
    if (!selectedRelease) return;
    if (selectedRelease.tag_name === appVersion) return;
    if (
      !window.confirm(
        `Zu Version ${selectedRelease.tag_name} wechseln?\n\nDer Installer wird heruntergeladen und gestartet. Die App sollte danach neu gestartet werden.`,
      )
    ) {
      return;
    }
    setInstallingVersion(true);
    try {
      const msg = await installSpecificVersion(selectedRelease.installer_url);
      showSuccess(msg, "Update");
      onSuccess?.();
    } catch (e) {
      showError(String(e), "Update");
    } finally {
      setInstallingVersion(false);
    }
  }

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

  return {
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
  };
}
