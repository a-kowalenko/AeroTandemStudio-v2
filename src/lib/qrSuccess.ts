/** Shared copy + dialog options for successful QR customer recognition. */

import { tr } from "@/i18n";
import type { Kunde, QrPreview } from "@/lib/tauri";
import {
  formatQrCleanupSummary,
  type QrCleanupResult,
} from "@/lib/qrCleanup";
import type { DialogActionStatus, DialogOptions } from "@/store/uiStore";

export function qrSuccessTitle(): string {
  return tr("app.qr.recognized");
}

/** @deprecated Use qrSuccessTitle() for i18n. */
export const QR_SUCCESS_TITLE = "QR-Code erkannt";

export function kundeDisplayName(
  kunde: Pick<Kunde, "vorname" | "nachname"> | null | undefined,
): string {
  if (!kunde) return "";
  return [kunde.vorname, kunde.nachname].filter(Boolean).join(" ").trim();
}

export function fileBaseName(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/^.*[/\\]/, "");
}

export type FormatQrSuccessInput = {
  kunde?: Pick<
    Kunde,
    "vorname" | "nachname" | "kunden_id" | "booking_id"
  > | null;
  cleanup?: QrCleanupResult;
  sourcePath?: string | null;
  /** Extra detail lines (e.g. "Datei nicht importiert.") */
  notes?: string[];
  /** Hit-frame preview for SuccessDialog spotlight. */
  preview?: QrPreview | null;
  /**
   * Numeric URL QR only: IDs applied, AMS did not return customer payload.
   * Must stay unset/false for hash/compact/legacy QR (unchanged success UX).
   */
  numericIdsOnly?: boolean;
  /**
   * Numeric URL QR with AMS (or IDs-only) apply — success copy mentions QR→ID.
   * Hash/compact/legacy leave this unset.
   */
  numericQr?: boolean;
};

/** Labeled ID pair for lookup/success UI (Kunde / Booking). */
export type QrIdChip = {
  label: string;
  value: string;
};

/** Build Kunden-ID / Booking-ID chips from plain numeric IDs. */
export function kundeIdChips(
  kunde: Pick<Kunde, "kunden_id" | "booking_id"> | null | undefined,
): QrIdChip[] {
  if (!kunde) return [];
  const chips: QrIdChip[] = [];
  const id = (kunde.kunden_id ?? "").trim();
  const booking = (kunde.booking_id ?? "").trim();
  if (id) {
    chips.push({ label: tr("form.customer.customerId"), value: id });
  }
  if (booking) {
    chips.push({ label: tr("form.customer.bookingId"), value: booking });
  }
  return chips;
}

/** Compact labeled string when chips are not available (e.g. success highlight). */
export function formatKundeIdHighlight(
  kunde: Pick<Kunde, "kunden_id" | "booking_id"> | null | undefined,
): string {
  return kundeIdChips(kunde)
    .map((c) => `${c.label} ${c.value}`)
    .join(" · ");
}

function numericIdsHighlight(
  kunde: Pick<Kunde, "kunden_id" | "booking_id"> | null | undefined,
): string {
  return formatKundeIdHighlight(kunde);
}

function collectQrSuccessDetail(input: FormatQrSuccessInput): string | undefined {
  const detailParts: string[] = [];
  if (input.numericIdsOnly) {
    detailParts.push(tr("ams.status.unreachableHint"));
  }
  for (const note of input.notes ?? []) {
    const trimmed = note.trim();
    if (trimmed) detailParts.push(trimmed);
  }
  const cleanup = input.cleanup
    ? formatQrCleanupSummary(input.cleanup).replace(/^\n/, "").trim().replace(/\.$/, "")
    : "";
  if (cleanup) detailParts.push(cleanup);
  return detailParts.length ? detailParts.join("\n") : undefined;
}

/** QR action tile (same shape as SD „Vorher bestätigen“ dialog). */
export function buildQrSuccessAction(
  input: FormatQrSuccessInput,
): DialogActionStatus {
  // No source filename — generic camera names are noise; thumb covers the hit.
  if (input.numericIdsOnly) {
    return {
      kind: "qr",
      label: tr("app.qr.label"),
      tone: "warning",
      summary: tr("app.qr.idsOnlyApplied"),
      detail: collectQrSuccessDetail(input),
    };
  }

  return {
    kind: "qr",
    label: tr("app.qr.label"),
    tone: "success",
    summary: input.numericQr
      ? tr("app.qr.numericApplied")
      : tr("app.qr.applied"),
    detail: collectQrSuccessDetail(input),
  };
}

/** Build title, body and QR-variant options for SuccessDialog. */
export function formatQrSuccess(input: FormatQrSuccessInput): {
  title: string;
  message: string;
  options: DialogOptions;
} {
  const name = kundeDisplayName(input.kunde);
  const action = buildQrSuccessAction(input);
  const highlight = input.numericIdsOnly
    ? numericIdsHighlight(input.kunde) || tr("app.qr.idsOnlyHighlight")
    : name || tr("app.sd.customerRecognized");

  return {
    title: qrSuccessTitle(),
    // Body lives in action tiles; keep message empty to avoid duplicate text.
    message: "",
    options: {
      variant: "qr",
      highlight,
      autoCloseSecs: 5,
      qrPreview: input.preview ?? null,
      actions: [action],
    },
  };
}
