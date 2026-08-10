import { create } from "zustand";
import type { Kunde } from "../lib/tauri";

function todayDe(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function emptyKunde(partial?: Partial<Kunde>): Kunde {
  return {
    kunden_id: null,
    kunden_id_hash: null,
    booking_id: null,
    booking_id_hash: null,
    vorname: null,
    nachname: null,
    email: null,
    telefon: null,
    gast: "",
    tandemmaster: "",
    videospringer: "",
    datum: todayDe(),
    ort: "Calden",
    video_mode: "",
    form_mode: "manual",
    handcam_foto: false,
    handcam_video: false,
    outside_foto: false,
    outside_video: false,
    ist_bezahlt_handcam_foto: false,
    ist_bezahlt_handcam_video: false,
    ist_bezahlt_outside_foto: false,
    ist_bezahlt_outside_video: false,
    ...partial,
  };
}

type KundeState = {
  kunde: Kunde;
  /** Last QR-applied customer; used to restore QR mode after a manual switch. */
  qrSnapshot: Kunde | null;
  /** Bumps on each successful QR apply (for UI lock sync). */
  qrRevision: number;
  setField: <K extends keyof Kunde>(key: K, value: Kunde[K]) => void;
  patch: (partial: Partial<Kunde>) => void;
  setVideoMode: (mode: "" | "handcam" | "outside") => void;
  /**
   * Aktiviert Foto-/Video-Produkte zum aktuellen Modus, wenn Medien vorhanden sind.
   * Setzt neu aktivierte Optionen auf „nicht bezahlt“; bestehende Haken bleiben.
   */
  autoCheckProducts: (hasVideos: boolean, hasPhotos: boolean) => void;
  applyDefaultsFromConfig: (opts: {
    ort?: string;
    tandemmaster?: string;
    videospringer?: string;
    gast_name?: string;
    outside_video?: boolean;
  }) => void;
  applyFromQr: (scanned: Kunde) => void;
  /** Toggle QR ↔ manual; restoring QR re-applies qrSnapshot (manual identity edits discarded). */
  switchFormMode: (mode: "kunde" | "manual") => void;
  resetSession: (keep?: {
    tandemmaster?: boolean;
    videospringer?: boolean;
  }) => void;
};

export const useKundeStore = create<KundeState>((set, get) => ({
  kunde: emptyKunde(),
  qrSnapshot: null,
  qrRevision: 0,

  setField: (key, value) => {
    set({ kunde: { ...get().kunde, [key]: value } });
  },

  patch: (partial) => {
    set({ kunde: { ...get().kunde, ...partial } });
  },

  setVideoMode: (mode) => {
    const k = get().kunde;
    if (mode === "handcam") {
      set({
        kunde: {
          ...k,
          video_mode: "handcam",
          outside_foto: false,
          outside_video: false,
          ist_bezahlt_outside_foto: false,
          ist_bezahlt_outside_video: false,
        },
      });
    } else if (mode === "outside") {
      set({
        kunde: {
          ...k,
          video_mode: "outside",
          outside_video: true,
          handcam_foto: false,
          handcam_video: false,
          ist_bezahlt_handcam_foto: false,
          ist_bezahlt_handcam_video: false,
        },
      });
    } else {
      set({
        kunde: {
          ...k,
          video_mode: "",
          handcam_foto: false,
          handcam_video: false,
          outside_foto: false,
          outside_video: false,
          ist_bezahlt_handcam_foto: false,
          ist_bezahlt_handcam_video: false,
          ist_bezahlt_outside_foto: false,
          ist_bezahlt_outside_video: false,
        },
      });
    }
  },

  autoCheckProducts: (hasVideos, hasPhotos) => {
    const k = get().kunde;
    const mode = k.video_mode;
    if (mode !== "handcam" && mode !== "outside") return;

    const patch: Partial<Kunde> = {};
    if (mode === "handcam") {
      if (hasVideos && !k.handcam_video) {
        patch.handcam_video = true;
        patch.ist_bezahlt_handcam_video = false;
      }
      if (hasPhotos && !k.handcam_foto) {
        patch.handcam_foto = true;
        patch.ist_bezahlt_handcam_foto = false;
      }
    } else {
      if (hasVideos && !k.outside_video) {
        patch.outside_video = true;
        patch.ist_bezahlt_outside_video = false;
      }
      if (hasPhotos && !k.outside_foto) {
        patch.outside_foto = true;
        patch.ist_bezahlt_outside_foto = false;
      }
    }

    if (Object.keys(patch).length === 0) return;
    set({ kunde: { ...k, ...patch } });
  },

  applyDefaultsFromConfig: (opts) => {
    const k = get().kunde;
    set({
      kunde: {
        ...k,
        ort: opts.ort || k.ort || "Calden",
        tandemmaster: k.tandemmaster || opts.tandemmaster || "",
        videospringer: k.videospringer || opts.videospringer || "",
        gast: k.gast || opts.gast_name || "",
        outside_video: k.outside_video || Boolean(opts.outside_video),
        video_mode:
          k.video_mode ||
          (opts.outside_video ? "outside" : k.video_mode),
      },
    });
  },

  applyFromQr: (scanned) => {
    const prev = get().kunde;
    const vorname = scanned.vorname ?? "";
    const nachname = scanned.nachname ?? "";
    const gastFromName = `${vorname} ${nachname}`.trim();

    let video_mode = prev.video_mode;
    if (scanned.handcam_foto || scanned.handcam_video) {
      video_mode = "handcam";
    } else if (scanned.outside_foto || scanned.outside_video) {
      video_mode = "outside";
    }

    const next: Kunde = {
      ...prev,
      // QR payloads use hash IDs — plain IDs / contact stay empty in QR mode.
      kunden_id: null,
      kunden_id_hash: scanned.kunden_id_hash ?? null,
      booking_id: null,
      booking_id_hash: scanned.booking_id_hash ?? null,
      vorname: scanned.vorname ?? null,
      nachname: scanned.nachname ?? null,
      email: null,
      telefon: null,
      gast: gastFromName || scanned.gast || prev.gast,
      form_mode: "kunde",
      video_mode,
      handcam_foto: scanned.handcam_foto,
      handcam_video: scanned.handcam_video,
      outside_foto: scanned.outside_foto,
      outside_video: scanned.outside_video,
      ist_bezahlt_handcam_foto: scanned.ist_bezahlt_handcam_foto,
      ist_bezahlt_handcam_video: scanned.ist_bezahlt_handcam_video,
      ist_bezahlt_outside_foto: scanned.ist_bezahlt_outside_foto,
      ist_bezahlt_outside_video: scanned.ist_bezahlt_outside_video,
      // Keep session fields from the form / config.
      ort: prev.ort,
      datum: prev.datum,
      tandemmaster: prev.tandemmaster,
      videospringer: prev.videospringer,
    };

    set({
      qrRevision: get().qrRevision + 1,
      qrSnapshot: { ...next },
      kunde: next,
    });
    // Lazy: vermeidet zirkulären Import mit video/photo stores.
    void import("../lib/syncProductsFromMedia").then(({ syncProductsFromMedia }) => {
      syncProductsFromMedia();
    });
  },

  switchFormMode: (mode) => {
    const { kunde, qrSnapshot } = get();
    if (mode === "manual") {
      if (kunde.form_mode === "manual") return;
      // Capture current QR state (incl. in-form edits) before leaving.
      const snapshot = { ...kunde, form_mode: "kunde" as const };
      set({
        qrSnapshot: snapshot,
        kunde: {
          ...kunde,
          form_mode: "manual",
          kunden_id_hash: null,
          booking_id_hash: null,
          email: null,
          telefon: null,
        },
      });
      return;
    }

    // Restore QR from snapshot — manual identity edits are discarded.
    if (!qrSnapshot || kunde.form_mode === "kunde") return;
    const restored: Kunde = {
      ...qrSnapshot,
      form_mode: "kunde",
      ort: kunde.ort,
      datum: kunde.datum,
      tandemmaster: kunde.tandemmaster,
      videospringer: kunde.videospringer,
    };
    set({
      qrRevision: get().qrRevision + 1,
      kunde: restored,
      qrSnapshot: { ...restored },
    });
    void import("../lib/syncProductsFromMedia").then(({ syncProductsFromMedia }) => {
      syncProductsFromMedia();
    });
  },

  resetSession: (keep) => {
    const prev = get().kunde;
    set({
      qrRevision: 0,
      qrSnapshot: null,
      kunde: emptyKunde({
        ort: prev.ort,
        tandemmaster: keep?.tandemmaster ? prev.tandemmaster : "",
        videospringer: keep?.videospringer ? prev.videospringer : "",
      }),
    });
  },
}));
