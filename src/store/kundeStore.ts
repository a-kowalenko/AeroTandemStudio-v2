import { create } from "zustand";
import type { AmsBridgeCustomer, Kunde, QrPreview } from "../lib/tauri";
import {
  applyBridgeCustomerToKunde,
  clearAmsLookupDerived,
} from "../lib/amsLookup";
import {
  discardQrPreviewBestEffort,
  takeQrPreview,
} from "../lib/qrPreviewSession";

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

export type ApplyFromQrOpts = {
  preview?: QrPreview | null;
  sourcePath?: string | null;
};

type KundeState = {
  kunde: Kunde;
  /** Last QR-applied customer; used to restore QR mode after a manual switch. */
  qrSnapshot: Kunde | null;
  /** Hit-frame preview for the current QR session (survives SuccessDialog close). */
  qrPreview: QrPreview | null;
  /** Source media path of the last QR hit (for display). */
  qrPreviewSource: string | null;
  /** Bumps on each successful QR apply (for UI lock sync). */
  qrRevision: number;
  /**
   * After QR or AMS identity apply: soft-highlight empty crew fields until
   * filled or session reset. Scroll/focus runs when blocking dialogs close
   * (QR success) or immediately after AMS apply.
   */
  crewAttentionAfterQr: boolean;
  /**
   * AMS ID-lookup lock (Phase 25). Independent of QR snapshot/revision.
   * Name, IDs and media are locked while true; crew stays editable.
   */
  amsLookupLocked: boolean;
  amsLookupRevision: number;
  /** IDs that produced the current AMS fill (skip re-lookup until they change). */
  amsLookupIds: { kunden_id: string; booking_id: string } | null;
  /**
   * After import without QR or QR miss: focus Kunden-ID once dialogs close.
   * Not set on session start / reset / mode switch.
   */
  kundenIdFocusPending: boolean;
  /**
   * Operator started editing this session (typed a field, switched mode, …).
   * Config defaults and derived `gast` sync do not set this.
   */
  sessionTouched: boolean;
  requestKundenIdFocus: () => void;
  clearKundenIdFocus: () => void;
  clearCrewAttentionAfterQr: () => void;
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
  applyFromQr: (scanned: Kunde, opts?: ApplyFromQrOpts) => void;
  applyFromAmsLookup: (hit: AmsBridgeCustomer, opts?: { videoMode?: "handcam" | "outside" }) => void;
  unlockAmsLookup: () => void;
  relockAmsLookup: () => void;
  /** Drop AMS lock without touching QR state. */
  clearAmsLookup: () => void;
  /** Toggle QR ↔ manual; restoring QR re-applies qrSnapshot (manual identity edits discarded). */
  switchFormMode: (mode: "kunde" | "manual") => void;
  resetSession: (keep?: {
    tandemmaster?: boolean;
    videospringer?: boolean;
    /** When keep is set and non-empty, restore this name; otherwise keep previous. */
    tandemmasterFixed?: string;
    videospringerFixed?: string;
  }) => void;
};

export const useKundeStore = create<KundeState>((set, get) => ({
  kunde: emptyKunde(),
  qrSnapshot: null,
  qrPreview: null,
  qrPreviewSource: null,
  qrRevision: 0,
  crewAttentionAfterQr: false,
  amsLookupLocked: false,
  amsLookupRevision: 0,
  amsLookupIds: null,
  kundenIdFocusPending: false,
  sessionTouched: false,

  requestKundenIdFocus: () => set({ kundenIdFocusPending: true }),
  clearKundenIdFocus: () => set({ kundenIdFocusPending: false }),
  clearCrewAttentionAfterQr: () => set({ crewAttentionAfterQr: false }),

  setField: (key, value) => {
    const prev = get().kunde;
    if (Object.is(prev[key], value)) return;
    const touch = key !== "gast";
    if (
      (key === "kunden_id" || key === "booking_id") &&
      get().amsLookupRevision > 0
    ) {
      set({
        kunde: clearAmsLookupDerived({ ...prev, [key]: value }),
        amsLookupLocked: false,
        amsLookupRevision: 0,
        amsLookupIds: null,
        ...(touch ? { sessionTouched: true } : {}),
      });
      return;
    }
    set({
      kunde: { ...prev, [key]: value },
      ...(touch ? { sessionTouched: true } : {}),
    });
  },

  patch: (partial) => {
    const prev = get().kunde;
    const touches = (Object.keys(partial) as (keyof Kunde)[]).some(
      (key) => key !== "gast" && !Object.is(prev[key], partial[key]),
    );
    set({
      kunde: { ...prev, ...partial },
      ...(touches ? { sessionTouched: true } : {}),
    });
  },

  setVideoMode: (mode) => {
    if (get().amsLookupLocked) return;
    const k = get().kunde;
    if (k.video_mode === mode) return;
    if (mode === "handcam") {
      set({
        sessionTouched: true,
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
        sessionTouched: true,
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
        sessionTouched: true,
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
    if (get().amsLookupLocked) return;
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

  applyFromQr: (scanned, opts) => {
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

    const preview =
      opts === undefined
        ? get().qrPreview
        : takeQrPreview(get().qrPreview, opts.preview ?? null);
    const sourcePath =
      opts === undefined
        ? get().qrPreviewSource
        : opts.sourcePath?.trim() || null;

    set({
      qrRevision: get().qrRevision + 1,
      crewAttentionAfterQr: true,
      qrSnapshot: { ...next },
      qrPreview: preview,
      qrPreviewSource: sourcePath,
      amsLookupLocked: false,
      amsLookupRevision: 0,
      amsLookupIds: null,
      kundenIdFocusPending: false,
      kunde: next,
    });
    // Lazy: vermeidet zirkulären Import mit video/photo stores.
    void import("../lib/syncProductsFromMedia").then(({ syncProductsFromMedia }) => {
      syncProductsFromMedia();
    });
  },

  applyFromAmsLookup: (hit, opts) => {
    const next = applyBridgeCustomerToKunde(get().kunde, hit, opts);
    set({
      amsLookupLocked: true,
      amsLookupRevision: get().amsLookupRevision + 1,
      amsLookupIds: {
        kunden_id: (next.kunden_id ?? "").trim(),
        booking_id: (next.booking_id ?? "").trim(),
      },
      crewAttentionAfterQr: true,
      kundenIdFocusPending: false,
      kunde: next,
    });
  },

  unlockAmsLookup: () => {
    if (!get().amsLookupLocked) return;
    set({ amsLookupLocked: false, sessionTouched: true });
  },

  relockAmsLookup: () => {
    if (get().amsLookupRevision <= 0) return;
    set({ amsLookupLocked: true });
  },

  clearAmsLookup: () => {
    set({
      amsLookupLocked: false,
      amsLookupRevision: 0,
      amsLookupIds: null,
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
        amsLookupLocked: false,
        amsLookupRevision: 0,
        amsLookupIds: null,
        sessionTouched: true,
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

    // Restore QR from snapshot — manual identity edits and AMS lock are discarded.
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
      amsLookupLocked: false,
      amsLookupRevision: 0,
      amsLookupIds: null,
      kundenIdFocusPending: false,
      sessionTouched: true,
      kunde: restored,
      qrSnapshot: { ...restored },
    });
    void import("../lib/syncProductsFromMedia").then(({ syncProductsFromMedia }) => {
      syncProductsFromMedia();
    });
  },

  resetSession: (keep) => {
    const prev = get().kunde;
    const oldPreview = get().qrPreview;
    discardQrPreviewBestEffort(oldPreview?.path);
    set({
      qrRevision: 0,
      crewAttentionAfterQr: false,
      qrSnapshot: null,
      qrPreview: null,
      qrPreviewSource: null,
      amsLookupLocked: false,
      amsLookupRevision: 0,
      amsLookupIds: null,
      kundenIdFocusPending: false,
      sessionTouched: false,
      kunde: emptyKunde({
        ort: prev.ort,
        tandemmaster: keep?.tandemmaster
          ? keep.tandemmasterFixed?.trim() || prev.tandemmaster
          : "",
        videospringer: keep?.videospringer
          ? keep.videospringerFixed?.trim() || prev.videospringer
          : "",
      }),
    });
  },
}));
