/** Phase 45: dual-family QR (`hc_ou` / `ou_hc`) → AMS hash-lookup + type choice. */

import toast from "react-hot-toast";
import {
  AMS_ID_LOOKUP_TYPES,
  askAmsTypeChoice,
  canRunAmsIdLookup,
  classifyTypedHits,
  formatTypeChoiceDetail,
  isAmsBridgeConfigured,
  isLookupNotFound,
  isLookupUnreachable,
  type AmsBridgeCustomer,
  type AmsMarkerType,
} from "@/lib/amsLookup";
import { presentAmsLookupError } from "@/lib/amsBridgeStatus";
import { StatusToastCard } from "@/components/StatusToastCard";
import { tr } from "@/i18n";
import {
  amsBridgeCustomerLookup,
  type Kunde,
} from "@/lib/tauri";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useUiStore } from "@/store/uiStore";

type LookupAttempt =
  | { kind: "hit"; markerType: AmsMarkerType; customer: AmsBridgeCustomer }
  | { kind: "not_found"; markerType: AmsMarkerType }
  | { kind: "error"; markerType: AmsMarkerType; message: string }
  | { kind: "unreachable"; markerType: AmsMarkerType };

export type QrDualResolveResult =
  | { kind: "resolved"; kunde: Kunde; offlineFallback: boolean }
  | { kind: "cancelled" }
  | { kind: "skip" };

function trimToNull(value: string | null | undefined): string | null {
  const t = (value ?? "").trim();
  return t ? t : null;
}

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

/** Map AMS hit onto QR kunde — keep hashes / `form_mode: kunde`, plain IDs null. */
export function applyAmsHitToQrKunde(
  qr: Kunde,
  hit: AmsBridgeCustomer,
  videoMode: "handcam" | "outside",
): Kunde {
  const vorname = trimToNull(hit.first_name) ?? qr.vorname;
  const nachname = trimToNull(hit.last_name) ?? qr.nachname;
  const gast =
    [vorname, nachname].filter(Boolean).join(" ").trim() || qr.gast;
  return {
    ...qr,
    kunden_id: null,
    booking_id: null,
    kunden_id_hash: qr.kunden_id_hash ?? null,
    booking_id_hash: qr.booking_id_hash ?? null,
    vorname,
    nachname,
    gast,
    form_mode: "kunde",
    video_mode: videoMode,
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

/** Offline / no AMS hit: set video_mode only, clear product flags. */
export function applyOfflineDualFamily(
  qr: Kunde,
  videoMode: "handcam" | "outside",
): Kunde {
  return {
    ...qr,
    kunden_id: null,
    booking_id: null,
    form_mode: "kunde",
    video_mode: videoMode,
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

async function lookupOneHash(
  customerId: string,
  bookingId: string,
  markerType: AmsMarkerType,
): Promise<LookupAttempt> {
  try {
    const resp = await amsBridgeCustomerLookup({
      customerId,
      bookingId,
      markerType,
      mode: "hash",
    });
    if (resp.ok && resp.customer) {
      return { kind: "hit", markerType, customer: resp.customer };
    }
    const code = resp.error?.code;
    const message = resp.error?.message ?? "";
    if (isLookupNotFound(code, message)) {
      return { kind: "not_found", markerType };
    }
    return {
      kind: "error",
      markerType,
      message: presentAmsLookupError(message),
    };
  } catch (e) {
    const message = String(e);
    if (isLookupUnreachable(message)) {
      return { kind: "unreachable", markerType };
    }
    return {
      kind: "error",
      markerType,
      message: presentAmsLookupError(message),
    };
  }
}

function combineHashAttempts(attempts: LookupAttempt[]):
  | { kind: "hit"; customer: AmsBridgeCustomer; videoMode: "handcam" | "outside" }
  | {
      kind: "choice";
      handcam: AmsBridgeCustomer;
      outside: AmsBridgeCustomer;
    }
  | { kind: "fallback"; bridgeError?: string } {
  const handcamHit = attempts.find(
    (a): a is Extract<LookupAttempt, { kind: "hit" }> =>
      a.kind === "hit" && a.markerType === "Handcam",
  );
  const outsideHit = attempts.find(
    (a): a is Extract<LookupAttempt, { kind: "hit" }> =>
      a.kind === "hit" && a.markerType === "Outside",
  );
  const classified = classifyTypedHits({
    handcam: handcamHit?.customer ?? null,
    outside: outsideHit?.customer ?? null,
  });
  if (classified.kind === "choice") return classified;
  if (classified.kind === "one") {
    return {
      kind: "hit",
      customer: classified.customer,
      videoMode: classified.videoMode,
    };
  }

  const error = attempts.find((a) => a.kind === "error");
  const bridgeError =
    error && error.kind === "error" ? error.message : undefined;
  return { kind: "fallback", bridgeError };
}

async function askOfflineFamilyChoice(): Promise<"handcam" | "outside" | "cancel"> {
  return askAmsTypeChoice({
    body: tr("qr.dual.offlineHint"),
  });
}

function toastProductsCheck(): void {
  showStatusToast(
    "qr-dual-products-check",
    tr("ams.lookup.typeChoiceTitle"),
    tr("qr.dual.productsCheck"),
  );
}

/**
 * When `dualFamily`, resolve Handcam/Outside via AMS hash-lookup (or offline choice).
 * Non-dual → `{ kind: "skip" }` (caller keeps scanned kunde as-is).
 */
export async function resolveQrDualFamily(
  scanned: Kunde,
  dualFamily: boolean | null | undefined,
): Promise<QrDualResolveResult> {
  if (!dualFamily) return { kind: "skip" };

  const customerHash = (scanned.kunden_id_hash ?? "").trim();
  const bookingHash = (scanned.booking_id_hash ?? "").trim();
  const config = useConfigStore.getState().config;
  const ams = useAmsBridgeStore.getState();
  const lookupLive = canRunAmsIdLookup({
    configured: isAmsBridgeConfigured(config),
    connected: ams.connected,
    capabilities: ams.capabilities,
  });

  const runOffline = async (
    bridgeError?: string,
  ): Promise<QrDualResolveResult> => {
    if (bridgeError) {
      showStatusToast("qr-dual-bridge-error", tr("app.qr.label"), bridgeError);
    }
    const choice = await askOfflineFamilyChoice();
    if (choice === "cancel") return { kind: "cancelled" };
    toastProductsCheck();
    return {
      kind: "resolved",
      kunde: applyOfflineDualFamily(scanned, choice),
      offlineFallback: true,
    };
  };

  if (!lookupLive || !customerHash) {
    return runOffline();
  }

  const ui = useUiStore.getState();
  const wasLoading = ui.loading;
  if (!wasLoading) {
    ui.setLoading(true, tr("ams.lookup.searching"));
  }
  let combined: ReturnType<typeof combineHashAttempts>;
  try {
    const attempts = await Promise.all(
      AMS_ID_LOOKUP_TYPES.map((markerType) =>
        lookupOneHash(customerHash, bookingHash, markerType),
      ),
    );
    combined = combineHashAttempts(attempts);
  } finally {
    if (!wasLoading) {
      useUiStore.getState().setLoading(false);
    }
  }

  if (combined.kind === "fallback") {
    return runOffline(combined.bridgeError);
  }

  if (combined.kind === "hit") {
    return {
      kind: "resolved",
      kunde: applyAmsHitToQrKunde(scanned, combined.customer, combined.videoMode),
      offlineFallback: false,
    };
  }

  const typeChoice = await askAmsTypeChoice({
    handcamDetail: formatTypeChoiceDetail(combined.handcam, "handcam"),
    outsideDetail: formatTypeChoiceDetail(combined.outside, "outside"),
  });
  if (typeChoice === "cancel") return { kind: "cancelled" };
  const picked =
    typeChoice === "outside"
      ? { customer: combined.outside, videoMode: "outside" as const }
      : { customer: combined.handcam, videoMode: "handcam" as const };
  return {
    kind: "resolved",
    kunde: applyAmsHitToQrKunde(scanned, picked.customer, picked.videoMode),
    offlineFallback: false,
  };
}
