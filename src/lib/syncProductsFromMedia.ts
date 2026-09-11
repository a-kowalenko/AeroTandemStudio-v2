import { useKundeStore } from "../store/kundeStore";
import { useVideoStore } from "../store/videoStore";
import { usePhotoStore } from "../store/photoStore";

/**
 * Aktiviert Foto-/Video-Optionen zum aktuellen Medien-Modus anhand vorhandener Medien.
 * Neu aktivierte Optionen bleiben unbezahlt; bestehende bezahlte Haken (QR/AMS) bleiben.
 * Läuft auch unter AMS-Lock (Nachverkauf: Medien → Produkt an, unbezahlt).
 *
 * Optional flags only force a side to true (OR with live list). Never pass
 * `false` to mean "ignore the other media type" — omit the flag instead.
 */
export function syncProductsFromMedia(flags?: {
  hasVideos?: boolean;
  hasPhotos?: boolean;
}) {
  const hasVideos =
    Boolean(flags?.hasVideos) || useVideoStore.getState().videoList.length > 0;
  const hasPhotos =
    Boolean(flags?.hasPhotos) || usePhotoStore.getState().photoList.length > 0;
  useKundeStore.getState().autoCheckProducts(hasVideos, hasPhotos);
}
