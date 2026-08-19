import { tr } from "@/i18n";
import { isLookupIdPairReady } from "@/lib/amsLookup";

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
  showChips: boolean;
};

export type SummarizeCreateHintsOpts = {
  workStarted: boolean;
  suppressEmptyMedia: boolean;
  /** Manual ID mode: defer Vorgang hints until IDs are complete and AMS lookup settled. */
  idEntryGrace?: boolean;
};

export type IdEntryGraceOpts = {
  active: boolean;
  kundenId: string | null | undefined;
  bookingId: string | null | undefined;
  amsLookupSettled: boolean;
  lookupLive: boolean;
};

/** True while the operator is still typing IDs or AMS lookup has not finished. */
export function isIdEntryGracePeriod(opts: IdEntryGraceOpts): boolean {
  if (!opts.active) return false;
  if (!isLookupIdPairReady(opts.kundenId, opts.bookingId)) return true;
  if (opts.lookupLive && !opts.amsLookupSettled) return true;
  return false;
}

function shouldSuppressGraceHint(meta: CreateReadyItem, grace: boolean): boolean {
  if (!grace) return false;
  if (
    (meta.target === "kunden-id" || meta.target === "booking-id") &&
    meta.kind === "invalid"
  ) {
    return true;
  }
  if (
    meta.kind === "missing" &&
    (meta.target === "name" ||
      meta.target === "email" ||
      meta.target === "produkt")
  ) {
    return true;
  }
  return false;
}

/** Drop ID/name/product hints during the ID-entry grace window (live UI only). */
export function filterGraceCreateHints(hints: string[], grace: boolean): string[] {
  if (!grace) return hints;
  return hints.filter((hint) => {
    const meta = classifyHint(hint);
    if (!meta) return true;
    return !shouldSuppressGraceHint(meta, true);
  });
}

type HintMeta = CreateReadyItem & {
  emptyMedia?: boolean;
};

/** Rust validation messages (German) → i18n meta keys. */
const HINT_META: Record<string, Omit<HintMeta, "label"> & { labelKey: string }> = {
  "Tandemmaster ist erforderlich": {
    labelKey: "create.ready.chips.tandemmaster",
    kind: "missing",
    target: "tandemmaster",
  },
  "Datum ist erforderlich": {
    labelKey: "create.ready.chips.date",
    kind: "missing",
    target: "datum",
  },
  "Vorname und Nachname sind erforderlich": {
    labelKey: "create.ready.chips.name",
    kind: "missing",
    target: "name",
  },
  "Email ist erforderlich": {
    labelKey: "create.ready.chips.email",
    kind: "missing",
    target: "email",
  },
  "Videospringer ist erforderlich bei Outside Video": {
    labelKey: "create.ready.chips.videospringer",
    kind: "missing",
    target: "videospringer",
  },
  "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein": {
    labelKey: "create.ready.chips.crewConflict",
    kind: "invalid",
    target: "videospringer",
  },
  "Bitte wählen Sie mindestens ein Produkt aus (Handcam/Outside Foto oder Video).": {
    labelKey: "create.ready.chips.product",
    kind: "missing",
    target: "produkt",
  },
  "Sie haben ein Video-Produkt ausgewählt, aber keine Videos hinzugefügt.": {
    labelKey: "create.ready.chips.videos",
    kind: "missing",
    target: "videos",
    emptyMedia: true,
  },
  "Sie haben ein Foto-Produkt ausgewählt, aber keine Fotos hinzugefügt.": {
    labelKey: "create.ready.chips.photos",
    kind: "missing",
    target: "fotos",
    emptyMedia: true,
  },
  "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.": {
    labelKey: "create.ready.chips.watermark",
    kind: "missing",
    target: "watermark",
  },
  "Validierung fehlgeschlagen": {
    labelKey: "create.validation.validation",
    kind: "invalid",
    target: "none",
  },
};

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

function metaFromHint(hint: string): HintMeta | null {
  const exact = HINT_META[hint];
  if (exact) {
    const { labelKey, ...rest } = exact;
    return { ...rest, label: tr(labelKey) };
  }
  if (hint.startsWith("Kunden-ID muss")) {
    return {
      label: tr("create.validation.customerId"),
      kind: "invalid",
      target: "kunden-id",
    };
  }
  if (hint.startsWith("Booking-ID muss")) {
    return {
      label: tr("create.validation.bookingId"),
      kind: "invalid",
      target: "booking-id",
    };
  }
  if (hint.includes("ist keine .mp4")) {
    return {
      label: tr("create.validation.notMp4"),
      kind: "invalid",
      target: "videos",
    };
  }
  if (hint.includes("existiert nicht")) {
    return {
      label: tr("create.validation.fileMissing"),
      kind: "invalid",
      target: "videos",
    };
  }
  return null;
}

export function isBlockingCreateHint(hint: string): boolean {
  return !hint.includes(SPEICHERORT_HINT);
}

export function shortCreateHintLabel(hint: string): string {
  const meta = metaFromHint(hint);
  if (meta) return meta.label;
  return hint;
}

function classifyHint(hint: string): HintMeta | null {
  if (!isBlockingCreateHint(hint)) return null;
  const meta = metaFromHint(hint);
  if (meta) return meta;
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
      ? tr("create.ready.headline.missingOne", { label: items[0].label })
      : items[0].label;
  }
  if (hasInvalid && !hasMissing) return tr("create.ready.headline.check");
  if (hasMissing && hasInvalid) return tr("create.ready.headline.incomplete");
  return tr("create.ready.headline.missingMany", { count: n });
}

export function summarizeCreateHints(
  hints: string[],
  opts: SummarizeCreateHintsOpts = {
    workStarted: true,
    suppressEmptyMedia: false,
    idEntryGrace: false,
  },
): CreateReadyBanner | null {
  const items = uniqueItems(
    filterGraceCreateHints(hints, opts.idEntryGrace ?? false).flatMap((hint) => {
      const meta = classifyHint(hint);
      if (!meta) return [];
      if (meta.kind === "missing" && !opts.workStarted) return [];
      const src = HINT_META[hint];
      if (src?.emptyMedia && opts.suppressEmptyMedia) return [];
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

/** Translate known Rust validation messages for display. */
export function translateValidationHint(hint: string): string {
  const keyMap: Record<string, string> = {
    "Tandemmaster ist erforderlich": "create.validation.tandemmasterRequired",
    "Datum ist erforderlich": "create.validation.dateRequired",
    "Vorname und Nachname sind erforderlich": "create.validation.nameRequired",
    "Email ist erforderlich": "create.validation.emailRequired",
    "Videospringer ist erforderlich bei Outside Video":
      "create.validation.videospringerRequired",
    "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein":
      "create.validation.crewConflict",
    "Bitte wählen Sie mindestens ein Produkt aus (Handcam/Outside Foto oder Video).":
      "create.validation.productRequired",
    "Sie haben ein Video-Produkt ausgewählt, aber keine Videos hinzugefügt.":
      "create.validation.videosMissing",
    "Sie haben ein Foto-Produkt ausgewählt, aber keine Fotos hinzugefügt.":
      "create.validation.photosMissing",
    "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.":
      "create.validation.watermarkRequired",
    "Video-Produkt ist nicht bezahlt — bitte mindestens ein Video für die Preview auswählen.":
      "create.validation.previewVideoRequired",
    "Speicherort ist nicht gesetzt. Bitte Ordner wählen.":
      "create.validation.storageNotSet",
    "Bitte mindestens eine Datei zum Nachreichen wählen.":
      "create.append.pickFile",
    "Zu viele Nachreichungen für diesen Vorgang (99).":
      "create.append.tooMany",
    "Validierung fehlgeschlagen": "create.validation.failed",
  };
  const key = keyMap[hint];
  return key ? tr(key) : hint;
}
