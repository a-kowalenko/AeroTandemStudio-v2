import { useKundeStore } from "../store/kundeStore";
import { useVideoStore } from "../store/videoStore";
import { usePhotoStore } from "../store/photoStore";

/**
 * Aktiviert Foto-/Video-Optionen zum aktuellen Medien-Modus anhand vorhandener Medien.
 * Neu aktivierte Optionen bleiben unbezahlt; bestehende Haken (z. B. aus QR) bleiben.
 */
export function syncProductsFromMedia(flags?: {
  hasVideos?: boolean;
  hasPhotos?: boolean;
}) {
  const hasVideos =
    flags?.hasVideos ?? useVideoStore.getState().videoList.length > 0;
  const hasPhotos =
    flags?.hasPhotos ?? usePhotoStore.getState().photoList.length > 0;
  useKundeStore.getState().autoCheckProducts(hasVideos, hasPhotos);
}
