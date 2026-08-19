/** Compact labels for create-job validation errors shown above Erstellen. */

const SPEICHERORT_HINT = "Speicherort";

export const CREATE_READY_IDS = {
  tandemmaster: "crew-tandemmaster",
  videospringer: "crew-videospringer",
  datum: "session-datum",
  vorname: "kunde-vorname",
  email: "kunde-email",
  kundenId: "kunde-kunden-id",
  bookingId: "kunde-booking-id",
  produkt: "kunde-medien",
  media: "media-dropzone",
  watermark: "photo-watermark",
} as const;

export type CreateReadyTarget =
  | "tandemmaster"
  | "videospringer"
  | "datum"
  | "name"
  | "email"
  | "kunden-id"
  | "booking-id"
  | "produkt"
  | "videos"
  | "fotos"
  | "watermark"
  | "none";

export type CreateReadyKind = "missing" | "invalid";

export type CreateReadyItem = {
  label: string;
  kind: CreateReadyKind;
  target: CreateReadyTarget;
};

export type CreateReadyBanner = {
  headline: string;
  items: CreateReadyItem[];
  /** False when the headline already names the single remaining item. */
  showChips: boolean;
};

export type SummarizeCreateHintsOpts = {
  workStarted: boolean;
  /** Hide “product selected but list empty” while import/SD/QR pipeline runs. */
  suppressEmptyMedia: boolean;
};

type HintMeta = CreateReadyItem & {
  /** Video/Foto list empty while a matching product is booked. */
  emptyMedia?: boolean;
};

const EXACT_META: Record<string, HintMeta> = {
  "Tandemmaster ist erforderlich": {
    label: "Tandemmaster",
    kind: "missing",
    target: "tandemmaster",
  },
  "Datum ist erforderlich": {
    label: "Datum",
    kind: "missing",
    target: "datum",
  },
  "Vorname und Nachname sind erforderlich": {
    label: "Name",
    kind: "missing",
    target: "name",
  },
  "Email ist erforderlich": {
    label: "E-Mail",
    kind: "missing",
    target: "email",
  },
  "Videospringer ist erforderlich bei Outside Video": {
    label: "Videospringer",
    kind: "missing",
    target: "videospringer",
  },
  "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein": {
    label: "Crew-Konflikt",
    kind: "invalid",
    target: "videospringer",
  },
  "Bitte wählen Sie mindestens ein Produkt aus (Handcam/Outside Foto oder Video).":
    {
      label: "Produkt",
      kind: "missing",
      target: "produkt",
    },
  "Sie haben ein Video-Produkt ausgewählt, aber keine Videos hinzugefügt.": {
    label: "Videos",
    kind: "missing",
    target: "videos",
    emptyMedia: true,
  },
  "Sie haben ein Foto-Produkt ausgewählt, aber keine Fotos hinzugefügt.": {
    label: "Fotos",
    kind: "missing",
    target: "fotos",
    emptyMedia: true,
  },
  "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.":
    {
      label: "Wasserzeichen",
      kind: "missing",
      target: "watermark",
    },
  "Validierung fehlgeschlagen": {
    label: "Validierung",
    kind: "invalid",
    target: "none",
  },
};

const EXACT_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(EXACT_META).map(([hint, meta]) => [hint, meta.label]),
);

const TARGET_IDS: Record<CreateReadyTarget, string | null> = {
  tandemmaster: CREATE_READY_IDS.tandemmaster,
  videospringer: CREATE_READY_IDS.videospringer,
  datum: CREATE_READY_IDS.datum,
  name: CREATE_READY_IDS.vorname,
  email: CREATE_READY_IDS.email,
  "kunden-id": CREATE_READY_IDS.kundenId,
  "booking-id": CREATE_READY_IDS.bookingId,
  produkt: CREATE_READY_IDS.produkt,
  videos: CREATE_READY_IDS.media,
  fotos: CREATE_READY_IDS.media,
  watermark: CREATE_READY_IDS.watermark,
  none: null,
};

export function isBlockingCreateHint(hint: string): boolean {
  return !hint.includes(SPEICHERORT_HINT);
}

export function shortCreateHintLabel(hint: string): string {
  const exact = EXACT_LABELS[hint];
  if (exact) return exact;
  if (hint.startsWith("Kunden-ID muss")) return "Kunden-ID";
  if (hint.startsWith("Booking-ID muss")) return "Booking-ID";
  if (hint.includes("ist keine .mp4")) return "Keine .mp4";
  if (hint.includes("existiert nicht")) return "Datei fehlt";
  return hint;
}

function classifyHint(hint: string): HintMeta | null {
  if (!isBlockingCreateHint(hint)) return null;
  const exact = EXACT_META[hint];
  if (exact) return exact;
  if (hint.startsWith("Kunden-ID muss")) {
    return { label: "Kunden-ID", kind: "invalid", target: "kunden-id" };
  }
  if (hint.startsWith("Booking-ID muss")) {
    return { label: "Booking-ID", kind: "invalid", target: "booking-id" };
  }
  if (hint.includes("ist keine .mp4")) {
    return { label: "Keine .mp4", kind: "invalid", target: "videos" };
  }
  if (hint.includes("existiert nicht")) {
    return { label: "Datei fehlt", kind: "invalid", target: "videos" };
  }
  return { label: hint, kind: "invalid", target: "none" };
}

function uniqueItems(items: CreateReadyItem[]): CreateReadyItem[] {
  const seen = new Set<string>();
  const out: CreateReadyItem[] = [];
  for (const item of items) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

function headlineFor(items: CreateReadyItem[]): string {
  const n = items.length;
  const hasMissing = items.some((i) => i.kind === "missing");
  const hasInvalid = items.some((i) => i.kind === "invalid");
  if (n === 1) {
    return items[0].kind === "missing"
      ? `Noch ${items[0].label}`
      : items[0].label;
  }
  if (hasInvalid && !hasMissing) return "Angaben prüfen";
  if (hasMissing && hasInvalid) return "Angaben unvollständig";
  return `Noch ${n} Angaben fehlen`;
}

/** Blocking create errors as a compact footer banner, or null if none. */
export function summarizeCreateHints(
  hints: string[],
  opts: SummarizeCreateHintsOpts = {
    workStarted: true,
    suppressEmptyMedia: false,
  },
): CreateReadyBanner | null {
  const items = uniqueItems(
    hints.flatMap((hint) => {
      const meta = classifyHint(hint);
      if (!meta) return [];
      if (meta.kind === "missing" && !opts.workStarted) return [];
      if (meta.emptyMedia && opts.suppressEmptyMedia) return [];
      return [{ label: meta.label, kind: meta.kind, target: meta.target }];
    }),
  );
  if (items.length === 0) return null;
  return {
    headline: headlineFor(items),
    items,
    showChips: items.length > 1,
  };
}

export function mediaTabForTarget(
  target: CreateReadyTarget,
): "video" | "foto" | null {
  if (target === "videos") return "video";
  if (target === "fotos" || target === "watermark") return "foto";
  return null;
}

export function focusCreateReadyTarget(
  target: CreateReadyTarget,
  opts?: { setMediaTab?: (tab: "video" | "foto") => void },
): void {
  const tab = mediaTabForTarget(target);
  if (tab && opts?.setMediaTab) opts.setMediaTab(tab);
  const id = TARGET_IDS[target];
  if (!id) return;
  window.setTimeout(
    () => {
      const el = document.getElementById(id);
      if (!(el instanceof HTMLElement)) return;
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.focus();
    },
    tab ? 80 : 0,
  );
}
