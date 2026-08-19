export const UI_LANGUAGES = ["de", "en", "es-MX"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(value: string | null | undefined): value is UiLanguage {
  return UI_LANGUAGES.includes(value as UiLanguage);
}

export function normalizeUiLanguage(
  value: string | null | undefined,
  fallback: UiLanguage = "de",
): UiLanguage {
  if (isUiLanguage(value)) return value;
  const lower = (value ?? "").trim().toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower === "es-mx" || lower === "es_mx") return "es-MX";
  if (lower.startsWith("es")) return "es-MX";
  if (lower.startsWith("de")) return "de";
  return fallback;
}

/** BCP-47 tag for Intl (dates, numbers, sort). */
export function intlLocaleFor(lang: UiLanguage): string {
  switch (lang) {
    case "en":
      return "en-US";
    case "es-MX":
      return "es-MX";
    default:
      return "de-DE";
  }
}

export function detectSystemUiLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return "de";
  const langs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const raw of langs) {
    const norm = normalizeUiLanguage(raw, "de");
    if (norm) return norm;
  }
  return "de";
}
