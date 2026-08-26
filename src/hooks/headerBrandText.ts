import type { HeaderSubtitleLevel } from "./useHeaderBrandCollapse";

export type HeaderSubtitleSource = {
  ready: boolean;
  hwLabel: string | null;
  secondaryBackup: {
    state: string;
    percent: number;
    file_name?: string | null;
  } | null;
};

function buildSubtitleFull(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string {
  const { ready, hwLabel, secondaryBackup } = source;
  if (
    secondaryBackup &&
    (secondaryBackup.state === "started" || secondaryBackup.state === "progress")
  ) {
    const base = t("app.chrome.serverBackupPercent", {
      percent: Math.round(secondaryBackup.percent),
    });
    return secondaryBackup.file_name ? `${base} · ${secondaryBackup.file_name}` : base;
  }
  if (secondaryBackup?.state === "done") {
    return t("app.chrome.serverBackupDone");
  }
  if (hwLabel) {
    return t("app.chrome.encoder", { label: hwLabel });
  }
  return ready ? t("app.chrome.ready") : t("app.chrome.starting");
}

function buildSubtitleCompact(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string {
  const { ready, hwLabel, secondaryBackup } = source;
  if (
    secondaryBackup &&
    (secondaryBackup.state === "started" || secondaryBackup.state === "progress")
  ) {
    return t("app.chrome.serverBackupPercent", {
      percent: Math.round(secondaryBackup.percent),
    });
  }
  if (secondaryBackup?.state === "done") {
    return t("app.chrome.serverBackupDone");
  }
  if (hwLabel) {
    return hwLabel;
  }
  return ready ? t("app.chrome.ready") : t("app.chrome.starting");
}

export function resolveHeaderSubtitleText(
  level: HeaderSubtitleLevel,
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string | null {
  if (level >= 2) return null;
  if (level === 1) {
    return buildSubtitleCompact(t, source);
  }
  return buildSubtitleFull(t, source);
}

export function buildHeaderSubtitleFull(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string {
  return buildSubtitleFull(t, source);
}
