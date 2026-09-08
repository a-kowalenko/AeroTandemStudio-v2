import { useConfigStore } from "../store/configStore";

const SOUND_URL = "/sounds/eject-ok.mp3";
/** Collapse rapid duplicate success calls (same idea as toast id `sd-eject-…-ok`). */
const DEBOUNCE_MS = 800;

let audio: HTMLAudioElement | null = null;
let lastPlayAt = 0;

/**
 * Play eject-success SFX when `sd_eject_sound_enabled` is on (default).
 * Never throws; never blocks the eject toast / workflow.
 */
export function playEjectSound(): void {
  const cfg = useConfigStore.getState().config;
  if (cfg?.sd_eject_sound_enabled === false) return;

  const now = Date.now();
  if (now - lastPlayAt < DEBOUNCE_MS) return;
  lastPlayAt = now;

  try {
    if (!audio) {
      audio = new Audio(SOUND_URL);
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    // Audio must never abort toast / settings / workflow.
  }
}
