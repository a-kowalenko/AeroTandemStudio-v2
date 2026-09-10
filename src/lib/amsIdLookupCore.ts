/** Shared AMS `mode=id` lookup (manual form + numeric QR). */

import {
  AMS_ID_LOOKUP_TYPES,
  classifyTypedHits,
  isLookupNotFound,
  isLookupUnreachable,
  type AmsBridgeCustomer,
  type AmsMarkerType,
} from "@/lib/amsLookup";
import { presentAmsLookupError } from "@/lib/amsBridgeStatus";
import { amsBridgeCustomerLookup } from "@/lib/tauri";

export type AmsIdLookupAttempt =
  | { kind: "hit"; markerType: AmsMarkerType; customer: AmsBridgeCustomer }
  | { kind: "not_found"; markerType: AmsMarkerType }
  | { kind: "error"; markerType: AmsMarkerType; message: string }
  | { kind: "unreachable"; markerType: AmsMarkerType };

export type AmsIdLookupCombined =
  | { kind: "hit"; customer: AmsBridgeCustomer; videoMode: "handcam" | "outside" }
  | {
      kind: "choice";
      handcam: AmsBridgeCustomer;
      outside: AmsBridgeCustomer;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "unreachable" };

export async function lookupOneAmsId(
  customerId: string,
  bookingId: string,
  markerType: AmsMarkerType,
): Promise<AmsIdLookupAttempt> {
  try {
    const resp = await amsBridgeCustomerLookup({
      customerId,
      bookingId,
      markerType,
      mode: "id",
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

export function combineAmsIdAttempts(
  attempts: AmsIdLookupAttempt[],
): AmsIdLookupCombined {
  const handcamHit = attempts.find(
    (a): a is Extract<AmsIdLookupAttempt, { kind: "hit" }> =>
      a.kind === "hit" && a.markerType === "Handcam",
  );
  const outsideHit = attempts.find(
    (a): a is Extract<AmsIdLookupAttempt, { kind: "hit" }> =>
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
  if (error && error.kind === "error") return error;

  if (attempts.some((a) => a.kind === "unreachable")) {
    return { kind: "unreachable" };
  }

  return { kind: "not_found" };
}

/** Parallel Handcam + Outside ID lookup. */
export async function runAmsIdPairLookup(
  customerId: string,
  bookingId: string,
): Promise<AmsIdLookupCombined> {
  const attempts = await Promise.all(
    AMS_ID_LOOKUP_TYPES.map((markerType) =>
      lookupOneAmsId(customerId, bookingId, markerType),
    ),
  );
  return combineAmsIdAttempts(attempts);
}
