/** create_job phase boundaries that may restart the overall percent bar. */
export const PROGRESS_PERCENT_RESET_STAGE =
  /^(vorgang wird erstellt|generiere ausgabe|übernehme vorschau|vorschau übernommen|erstelle wasserzeichen-video|wasserzeichen-video:|kopiere fotos|kopiere foto \(|erstelle foto-wasserzeichen|foto-wasserzeichen|schreibe _fertig|überspringe _fertig|vorgang fertig|upload\b)/i;

/**
 * Start of a create_video sub-step — overall bar resets to 0–100 % for this operation.
 * Must NOT match in-step statuses (compatible-finalize, continue, videoclips vorbereitet @100 %).
 */
export const VIDEO_STEP_START_RESET =
  /^(Bereite Videoclips vor…|Füge Clips zusammen…|Füge kodierte Clips zusammen…|Erstelle Intro…|Exportiere Intro \(Universal\)…|Bereite Video vor \(Universal\)…|Exportiere Video \(Universal\)…|Exportiere Intro\+Video \(Universal|Kodiere Intro\+Video \(kompatibel\)…|Kodiere Intro\+Video \(Audio-Copy\)…|Kodiere Intro\+Video neu:|Kodiere Intro\+Video: HEVC|Kodiere neu|Füge Intro und Video zusammen…|Audio anhängen \(Copy\)…|Exportiere Video…|Exportiere Video ohne Intro \(Stream-Copy\)…|Export fertig)/i;

/**
 * True when the overall progress bar should restart (0–100 %) for the new step.
 */
export function shouldResetOverallProgressPercent(
  status: string | undefined | null,
): boolean {
  const s = (status ?? "").trim();
  if (!s) return false;
  return (
    PROGRESS_PERCENT_RESET_STAGE.test(s) ||
    VIDEO_STEP_START_RESET.test(s)
  );
}
