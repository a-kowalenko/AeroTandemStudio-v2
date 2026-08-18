/** AMS ID-lookup mapping (Phase 25). No hashes; `form_mode` stays `manual`. */

import type { AmsBridgeCustomer, Kunde } from "@/lib/tauri";
import { kundeDisplayName } from "@/lib/qrSuccess";

export type { AmsBridgeCustomer };

export const AMS_LOOKUP_DEBOUNCE_MS = 500;
export const AMS_LOOKUP_MIN_ID_DIGITS = 4;

export type AmsMarkerType = "Handcam" | "Outside";

/** ID-mode always queries both AMS types (do not merge hits). */
export const AMS_ID_LOOKUP_TYPES: readonly AmsMarkerType[] = ["Handcam", "Outside"];

export function isLookupIdReady(id: string | null | undefined): boolean {
  const t = (id ?? "").trim();
  return t.length >= AMS_LOOKUP_MIN_ID_DIGITS && /^\d+$/.test(t);
}

export function isLookupIdPairReady(
  customerId: string | null | undefined,
  bookingId: string | null | undefined,
): boolean {
  return isLookupIdReady(customerId) && isLookupIdReady(bookingId);
}

/** Hint while the user is still typing a short ID. Empty / ready → no hint. */
export function lookupIdLengthHint(id: string | null | undefined): string | null {
  const t = (id ?? "").trim();
  if (t.length === 0 || isLookupIdReady(t)) return null;
  return `Mindestens ${AMS_LOOKUP_MIN_ID_DIGITS} Ziffern`;
}

function trimToNull(value: string | null | undefined): string | null {
  const t = (value ?? "").trim();
  return t ? t : null;
}

export function hasMediaFlags(customer: AmsBridgeCustomer): boolean {
  return Boolean(
    customer.handcam_foto ||
      customer.handcam_video ||
      customer.outside_foto ||
      customer.outside_video,
  );
}

function typeToVideoMode(customerType: string | null | undefined): "handcam" | "outside" | "" {
  const t = (customerType ?? "").trim().toLowerCase();
  if (t === "handcam" || t === "handycam") return "handcam";
  if (t === "outside") return "outside";
  return "";
}

export function videoModeFromCustomer(
  customer: AmsBridgeCustomer,
): "" | "handcam" | "outside" {
  const handcam = Boolean(customer.handcam_foto || customer.handcam_video);
  const outside = Boolean(customer.outside_foto || customer.outside_video);
  if (handcam && !outside) return "handcam";
  if (outside && !handcam) return "outside";
  const fromType = typeToVideoMode(customer.type);
  if (fromType) return fromType;
  if (handcam) return "handcam";
  return "";
}

export type ClassifiedLookupHits =
  | { kind: "none" }
  | { kind: "one"; customer: AmsBridgeCustomer; videoMode: "handcam" | "outside" }
  | {
      kind: "choice";
      handcam: AmsBridgeCustomer;
      outside: AmsBridgeCustomer;
    };

/** Two typed AMS responses: never merge families — ask when both have media flags. */
export function classifyTypedHits(opts: {
  handcam?: AmsBridgeCustomer | null;
  outside?: AmsBridgeCustomer | null;
}): ClassifiedLookupHits {
  const h = opts.handcam && hasMediaFlags(opts.handcam) ? opts.handcam : null;
  const o = opts.outside && hasMediaFlags(opts.outside) ? opts.outside : null;
  if (h && o) return { kind: "choice", handcam: h, outside: o };
  if (h) return { kind: "one", customer: h, videoMode: "handcam" };
  if (o) return { kind: "one", customer: o, videoMode: "outside" };
  return { kind: "none" };
}

export function formatTypeChoiceDetail(
  customer: AmsBridgeCustomer,
  family: "handcam" | "outside",
): string {
  const name = [customer.first_name, customer.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const foto = family === "handcam" ? customer.handcam_foto : customer.outside_foto;
  const video = family === "handcam" ? customer.handcam_video : customer.outside_video;
  const fotoPaid =
    family === "handcam"
      ? customer.ist_bezahlt_handcam_foto
      : customer.ist_bezahlt_outside_foto;
  const videoPaid =
    family === "handcam"
      ? customer.ist_bezahlt_handcam_video
      : customer.ist_bezahlt_outside_video;
  const kinds = [
    video ? (videoPaid ? "Video (bezahlt)" : "Video") : "",
    foto ? (fotoPaid ? "Foto (bezahlt)" : "Foto") : "",
  ].filter(Boolean);
  const media = kinds.length ? kinds.join(" · ") : family === "handcam" ? "Handcam" : "Outside";
  return name ? `${name} · ${media}` : media;
}

/** Derived name/media from AMS — IDs, crew, contact stay. */
export function clearAmsLookupDerived(kunde: Kunde): Kunde {
  return {
    ...kunde,
    vorname: null,
    nachname: null,
    gast: "",
    video_mode: "",
    handcam_foto: false,
    handcam_video: false,
    outside_foto: false,
    outside_video: false,
    ist_bezahlt_handcam_foto: false,
    ist_bezahlt_handcam_video: false,
    ist_bezahlt_outside_foto: false,
    ist_bezahlt_outside_video: false,
  };
}

export function applyBridgeCustomerToKunde(
  kunde: Kunde,
  hit: AmsBridgeCustomer,
  opts?: { videoMode?: "handcam" | "outside" },
): Kunde {
  const vorname = trimToNull(hit.first_name);
  const nachname = trimToNull(hit.last_name);
  const gast = [vorname, nachname].filter(Boolean).join(" ").trim() || kunde.gast;
  return {
    ...kunde,
    kunden_id: kunde.kunden_id ?? null,
    booking_id: kunde.booking_id ?? null,
    kunden_id_hash: null,
    booking_id_hash: null,
    vorname,
    nachname,
    gast,
    form_mode: "manual",
    video_mode: opts?.videoMode ?? videoModeFromCustomer(hit),
    handcam_foto: Boolean(hit.handcam_foto),
    handcam_video: Boolean(hit.handcam_video),
    outside_foto: Boolean(hit.outside_foto),
    outside_video: Boolean(hit.outside_video),
    ist_bezahlt_handcam_foto: Boolean(hit.ist_bezahlt_handcam_foto),
    ist_bezahlt_handcam_video: Boolean(hit.ist_bezahlt_handcam_video),
    ist_bezahlt_outside_foto: Boolean(hit.ist_bezahlt_outside_foto),
    ist_bezahlt_outside_video: Boolean(hit.ist_bezahlt_outside_video),
  };
}

export function isAmsBridgeConfigured(config: {
  ams_bridge_url?: string | null;
  ams_bridge_last_ok_url?: string | null;
} | null | undefined): boolean {
  if (!config) return false;
  return Boolean(
    (config.ams_bridge_url ?? "").trim() ||
      (config.ams_bridge_last_ok_url ?? "").trim(),
  );
}

export function isLookupUnreachable(message: string): boolean {
  return message.includes("nicht erreichbar");
}

export function isLookupNotFound(
  code: string | null | undefined,
  message: string | null | undefined,
): boolean {
  const c = (code ?? "").trim().toLowerCase();
  if (
    c === "customer_lookup_failed" ||
    c === "not_found" ||
    c.includes("not_found")
  ) {
    return true;
  }
  const m = (message ?? "").toLowerCase();
  return m.includes("nicht gefunden") || m.includes("not found");
}

export function needsAmsLookupOverrideConfirm(
  current: Kunde,
  incoming: AmsBridgeCustomer,
): boolean {
  if (current.form_mode !== "manual") return false;
  const curName = kundeDisplayName(current);
  if (!curName) return false;
  const nextName = [incoming.first_name, incoming.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!nextName) return false;
  return curName.toLowerCase() !== nextName.toLowerCase();
}

function mediaParts(kunde: Pick<
  Kunde,
  | "video_mode"
  | "handcam_foto"
  | "handcam_video"
  | "outside_foto"
  | "outside_video"
>): { family: string; kinds: string[] } {
  const mode = kunde.video_mode;
  const foto = mode === "handcam" ? kunde.handcam_foto : kunde.outside_foto;
  const video = mode === "handcam" ? kunde.handcam_video : kunde.outside_video;
  const family = mode === "handcam" ? "Handcam" : mode === "outside" ? "Outside" : "";
  const kinds = [foto ? "Foto" : "", video ? "Video" : ""].filter(Boolean);
  return { family, kinds };
}

function mediaStatusLabel(kunde: Pick<
  Kunde,
  | "video_mode"
  | "handcam_foto"
  | "handcam_video"
  | "outside_foto"
  | "outside_video"
>): string {
  const { family, kinds } = mediaParts(kunde);
  if (!family) return "";
  if (!kinds.length) return family;
  return `${family} ${kinds.join(" · ")}`;
}

/** Toast badge: `Outside · Foto/Video`. */
function mediaToastLabel(kunde: Pick<
  Kunde,
  | "video_mode"
  | "handcam_foto"
  | "handcam_video"
  | "outside_foto"
  | "outside_video"
>): string {
  const { family, kinds } = mediaParts(kunde);
  if (!family) return "";
  if (!kinds.length) return family;
  return `${family} · ${kinds.join("/")}`;
}

export const AMS_LOOKUP_FOUND_TITLE = "AMS-Kunde gefunden";

export function formatAmsLookupFoundLine(kunde: Kunde): string {
  const name = kundeDisplayName(kunde) || "Kunde";
  const media = mediaStatusLabel(kunde);
  return media ? `Gefunden: ${name} · ${media}` : `Gefunden: ${name}`;
}

export function formatAmsLookupFoundToast(kunde: Kunde): {
  title: string;
  name: string;
  media: string;
} {
  return {
    title: AMS_LOOKUP_FOUND_TITLE,
    name: kundeDisplayName(kunde) || "Kunde",
    media: mediaToastLabel(kunde),
  };
}

export type AmsLookupStatusKind = "idle" | "searching" | "found" | "not_found" | "error";

export type AmsLookupStatus = {
  kind: AmsLookupStatusKind;
  text: string;
};

export const AMS_LOOKUP_STATUS_SEARCHING: AmsLookupStatus = {
  kind: "searching",
  text: "Suche…",
};

export const AMS_LOOKUP_STATUS_NOT_FOUND: AmsLookupStatus = {
  kind: "not_found",
  text: "Kunde nicht gefunden",
};
