/** Compact labels for create-job validation errors shown above Erstellen. */

const SPEICHERORT_HINT = "Speicherort";

const EXACT_LABELS: Record<string, string> = {
  "Tandemmaster ist erforderlich": "Tandemmaster",
  "Datum ist erforderlich": "Datum",
  "Vorname und Nachname sind erforderlich": "Name",
  "Email ist erforderlich": "E-Mail",
  "Videospringer ist erforderlich bei Outside Video": "Videospringer",
  "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein":
    "Crew-Konflikt",
  "Bitte wählen Sie mindestens ein Produkt aus (Handcam/Outside Foto oder Video).":
    "Produkt",
  "Sie haben ein Video-Produkt ausgewählt, aber keine Videos hinzugefügt.":
    "Videos",
  "Sie haben ein Foto-Produkt ausgewählt, aber keine Fotos hinzugefügt.":
    "Fotos",
  "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.":
    "Wasserzeichen",
  "Validierung fehlgeschlagen": "Validierung",
};

export type CreateReadyBanner = {
  headline: string;
  labels: string[];
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

function uniquePreserve(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Blocking create errors as a compact footer banner, or null if none. */
export function summarizeCreateHints(hints: string[]): CreateReadyBanner | null {
  const labels = uniquePreserve(
    hints.filter(isBlockingCreateHint).map(shortCreateHintLabel),
  );
  if (labels.length === 0) return null;
  const n = labels.length;
  return {
    headline: n === 1 ? "Noch 1 Angabe fehlt" : `Noch ${n} Angaben fehlen`,
    labels,
  };
}
