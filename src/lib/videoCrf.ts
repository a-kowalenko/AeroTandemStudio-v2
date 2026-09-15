/** Preset CRF steps for quality dropdowns (lower = better / larger). */
export const VIDEO_CRF_OPTIONS = [18, 20, 23, 26] as const;

export type VideoCrfOption = (typeof VIDEO_CRF_OPTIONS)[number];

/** Snap an arbitrary CRF to the nearest settings step. */
export function nearestVideoCrf(raw: number): VideoCrfOption {
  let best: VideoCrfOption = VIDEO_CRF_OPTIONS[0];
  let bestDist = Math.abs(raw - best);
  for (const v of VIDEO_CRF_OPTIONS) {
    const d = Math.abs(raw - v);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

/** i18n key under `settings.encoding` for a CRF step label. */
export function videoCrfLabelKey(crf: number): string {
  switch (nearestVideoCrf(crf)) {
    case 18:
      return "settings.encoding.crfVeryHigh";
    case 20:
      return "settings.encoding.crfHigh";
    case 23:
      return "settings.encoding.crfBalanced";
    case 26:
      return "settings.encoding.crfSmall";
  }
}
