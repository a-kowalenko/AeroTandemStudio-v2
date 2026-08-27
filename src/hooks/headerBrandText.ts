import type { HeaderSubtitleLevel } from "./useHeaderBrandCollapse";

export type HeaderSubtitleSource = {
  ready: boolean;
  hwLabel: string | null;
};

function buildSubtitleFull(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string {
  const { ready, hwLabel } = source;
  if (hwLabel) {
    return t("app.chrome.encoder", { label: hwLabel });
  }
  return ready ? t("app.chrome.ready") : t("app.chrome.starting");
}

function buildSubtitleCompact(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: HeaderSubtitleSource,
): string {
  const { ready, hwLabel } = source;
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
