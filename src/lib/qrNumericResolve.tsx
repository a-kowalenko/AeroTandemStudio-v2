/** Numeric URL-only QR (`/qr/{n}?b={n}`) → AMS `mode=id` lookup. */

import toast from "react-hot-toast";
import {
  askAmsTypeChoice,
  canRunAmsIdLookup,
  formatTypeChoiceDetail,
  isAmsBridgeConfigured,
  isLookupIdPairReady,
  applyBridgeCustomerToKunde,
} from "@/lib/amsLookup";
import { runAmsIdPairLookup } from "@/lib/amsIdLookupCore";
import { StatusToastCard } from "@/components/StatusToastCard";
import { tr } from "@/i18n";
import type { Kunde } from "@/lib/tauri";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useUiStore } from "@/store/uiStore";

export type QrNumericResolveResult =
  | { kind: "resolved"; kunde: Kunde; fromAms: boolean }
  | { kind: "cancelled" }
  | { kind: "skip" };

function showStatusToast(id: string, title: string, message: string): void {
  const durationMs = 4000;
  toast.custom(
    (t) => (
      <StatusToastCard
        visible={t.visible}
        title={title}
        message={message}
        durationMs={durationMs}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: durationMs, id },
  );
}

/** Keep plain IDs / manual mode; clear hashes and product flags. */
export function applyNumericQrIdsOnly(scanned: Kunde): Kunde {
  const kunden_id = (scanned.kunden_id ?? "").trim() || null;
  const booking_id = (scanned.booking_id ?? "").trim() || null;
  return {
    ...scanned,
    kunden_id,
    booking_id,
    kunden_id_hash: null,
    booking_id_hash: null,
    vorname: null,
    nachname: null,
    email: null,
    telefon: null,
    gast: "",
    form_mode: "manual",
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

/**
 * When `numericIds`, resolve via AMS ID-lookup (or keep IDs only offline).
 * Non-numeric → `{ kind: "skip" }`.
 */
export async function resolveQrNumericIds(
  scanned: Kunde,
  numericIds: boolean | null | undefined,
): Promise<QrNumericResolveResult> {
  if (!numericIds) return { kind: "skip" };

  const idsOnly = applyNumericQrIdsOnly(scanned);
  const customerId = (idsOnly.kunden_id ?? "").trim();
  const bookingId = (idsOnly.booking_id ?? "").trim();
  if (!isLookupIdPairReady(customerId, bookingId)) {
    showStatusToast(
      "qr-numeric-ids-invalid",
      tr("app.qr.label"),
      tr("ams.lookup.notFound"),
    );
    return { kind: "resolved", kunde: idsOnly, fromAms: false };
  }

  const config = useConfigStore.getState().config;
  const ams = useAmsBridgeStore.getState();
  const lookupLive = canRunAmsIdLookup({
    configured: isAmsBridgeConfigured(config),
    connected: ams.connected,
    capabilities: ams.capabilities,
  });

  if (!lookupLive) {
    return { kind: "resolved", kunde: idsOnly, fromAms: false };
  }

  const ui = useUiStore.getState();
  const wasLoading = ui.loading;
  if (!wasLoading) {
    ui.setLoading(true, tr("ams.lookup.searching"));
  }
  let combined: Awaited<ReturnType<typeof runAmsIdPairLookup>>;
  try {
    combined = await runAmsIdPairLookup(customerId, bookingId);
  } finally {
    if (!wasLoading) {
      useUiStore.getState().setLoading(false);
    }
  }

  if (combined.kind === "unreachable" || combined.kind === "error") {
    if (combined.kind === "error") {
      showStatusToast("qr-numeric-bridge-error", tr("app.qr.label"), combined.message);
    }
    return { kind: "resolved", kunde: idsOnly, fromAms: false };
  }

  if (combined.kind === "not_found") {
    showStatusToast(
      "qr-numeric-not-found",
      tr("app.qr.label"),
      tr("ams.lookup.notFound"),
    );
    return { kind: "resolved", kunde: idsOnly, fromAms: false };
  }

  let customer = combined.kind === "hit" ? combined.customer : null;
  let videoMode: "handcam" | "outside" =
    combined.kind === "hit" ? combined.videoMode : "handcam";

  if (combined.kind === "choice") {
    const typeChoice = await askAmsTypeChoice({
      handcamDetail: formatTypeChoiceDetail(combined.handcam, "handcam"),
      outsideDetail: formatTypeChoiceDetail(combined.outside, "outside"),
    });
    if (typeChoice === "cancel") return { kind: "cancelled" };
    customer =
      typeChoice === "outside" ? combined.outside : combined.handcam;
    videoMode = typeChoice === "outside" ? "outside" : "handcam";
  }

  if (!customer) {
    return { kind: "resolved", kunde: idsOnly, fromAms: false };
  }

  return {
    kind: "resolved",
    kunde: applyBridgeCustomerToKunde(idsOnly, customer, { videoMode }),
    fromAms: true,
  };
}
