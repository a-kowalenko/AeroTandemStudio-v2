/** Confirm + run AMS `mode=id` lookup; discard stale responses. */

import { useEffect, useRef, useState } from "react";
import {
  AMS_ID_LOOKUP_TYPES,
  AMS_LOOKUP_DEBOUNCE_MS,
  AMS_LOOKUP_STATUS_NOT_FOUND,
  AMS_LOOKUP_STATUS_SEARCHING,
  classifyTypedHits,
  formatAmsLookupFoundLine,
  formatTypeChoiceDetail,
  isAmsBridgeConfigured,
  isLookupIdPairReady,
  isLookupNotFound,
  isLookupUnreachable,
  needsAmsLookupOverrideConfirm,
  type AmsBridgeCustomer,
  type AmsLookupStatus,
  type AmsMarkerType,
} from "@/lib/amsLookup";
import { amsBridgeCustomerLookup, type AppConfig } from "@/lib/tauri";
import { showAmsLookupFoundToast } from "@/lib/amsLookupToast";
import { kundeDisplayName } from "@/lib/qrSuccess";
import { useKundeStore } from "@/store/kundeStore";
import { useUiStore } from "@/store/uiStore";

type LookupAttempt =
  | { kind: "hit"; markerType: AmsMarkerType; customer: AmsBridgeCustomer }
  | { kind: "not_found"; markerType: AmsMarkerType }
  | { kind: "error"; markerType: AmsMarkerType; message: string }
  | { kind: "unreachable"; markerType: AmsMarkerType };

function lookupKey(customerId: string, bookingId: string): string {
  return `${customerId}\0${bookingId}`;
}

async function lookupOne(
  customerId: string,
  bookingId: string,
  markerType: AmsMarkerType,
): Promise<LookupAttempt> {
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
      message: message.trim() || "AMS-Lookup fehlgeschlagen",
    };
  } catch (e) {
    const message = String(e);
    if (isLookupUnreachable(message)) {
      return { kind: "unreachable", markerType };
    }
    return {
      kind: "error",
      markerType,
      message: message.trim() || "AMS-Lookup fehlgeschlagen",
    };
  }
}

function combineAttempts(attempts: LookupAttempt[]):
  | { kind: "hit"; customer: AmsBridgeCustomer; videoMode: "handcam" | "outside" }
  | {
      kind: "choice";
      handcam: AmsBridgeCustomer;
      outside: AmsBridgeCustomer;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "unreachable" } {
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
  if (error && error.kind === "error") return error;

  if (attempts.some((a) => a.kind === "unreachable")) {
    return { kind: "unreachable" };
  }

  return { kind: "not_found" };
}

function askAmsOverride(opts: {
  previousLabel: string;
  nextName: string;
}): Promise<"apply" | "keep"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: "apply" | "keep") => {
      if (settled) return;
      settled = true;
      useUiStore.getState().closeDialog();
      resolve(choice);
    };
    const previous = opts.previousLabel.trim() || "Manuelle Eingabe";
    const next = opts.nextName.trim() || "Neuer Kunde";
    useUiStore.getState().showSuccess(
      `Manuell: ${previous}\nAMS: ${next}\n\nManuelle Kundendaten verwerfen und AMS übernehmen?\nOrt, Datum und Crew bleiben erhalten.`,
      "AMS-Kunde gefunden",
      {
        highlight: next,
        autoCloseSecs: 0,
        confirm: {
          secondaryLabel: "Behalten",
          primaryLabel: "AMS übernehmen",
          onSecondary: () => finish("keep"),
          onPrimary: () => finish("apply"),
        },
      },
    );
  });
}

function askAmsTypeChoice(opts: {
  handcam: AmsBridgeCustomer;
  outside: AmsBridgeCustomer;
}): Promise<"handcam" | "outside" | "cancel"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: "handcam" | "outside" | "cancel") => {
      if (settled) return;
      settled = true;
      useUiStore.getState().closeDialog();
      resolve(choice);
    };
    useUiStore.getState().showSuccess(
      "Für diese IDs gibt es Handcam- und Outside-Daten.\nBitte den Medien-Typ wählen.",
      "Medien-Typ wählen",
      {
        autoCloseSecs: 0,
        choices: {
          options: [
            {
              id: "handcam",
              label: "Handcam",
              detail: formatTypeChoiceDetail(opts.handcam, "handcam"),
            },
            {
              id: "outside",
              label: "Outside",
              detail: formatTypeChoiceDetail(opts.outside, "outside"),
            },
          ],
          cancelLabel: "Abbrechen",
          onPick: (id) =>
            finish(id === "outside" ? "outside" : "handcam"),
          onCancel: () => finish("cancel"),
        },
      },
    );
  });
}

async function confirmAndApply(
  customer: AmsBridgeCustomer,
  videoMode: "handcam" | "outside",
  requestId: number,
  requestIdRef: { current: number },
): Promise<"applied" | "kept" | "stale"> {
  const current = useKundeStore.getState().kunde;
  if (needsAmsLookupOverrideConfirm(current, customer)) {
    const choice = await askAmsOverride({
      previousLabel: kundeDisplayName(current),
      nextName: [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(" ")
        .trim(),
    });
    if (requestIdRef.current !== requestId) return "stale";
    if (choice === "keep") return "kept";
  }
  if (requestIdRef.current !== requestId) return "stale";
  useKundeStore.getState().applyFromAmsLookup(customer, { videoMode });
  return "applied";
}

export function useAmsIdLookup(opts: {
  enabled: boolean;
  config: AppConfig | null;
}): AmsLookupStatus {
  const { enabled, config } = opts;
  const kunde = useKundeStore((s) => s.kunde);
  const amsLookupIds = useKundeStore((s) => s.amsLookupIds);
  const amsLookupRevision = useKundeStore((s) => s.amsLookupRevision);
  const [status, setStatus] = useState<AmsLookupStatus>({
    kind: "idle",
    text: "",
  });
  const requestIdRef = useRef(0);
  const attemptedKeyRef = useRef<string>("");

  const customerId = (kunde.kunden_id ?? "").trim();
  const bookingId = (kunde.booking_id ?? "").trim();
  const idsReady = isLookupIdPairReady(customerId, bookingId);
  const bridgeConfigured = isAmsBridgeConfigured(config);
  const bridgeKey = `${config?.ams_bridge_url ?? ""}\0${config?.ams_bridge_token ?? ""}\0${config?.ams_bridge_last_ok_url ?? ""}`;
  const idsMatchApplied =
    amsLookupIds != null &&
    amsLookupIds.kunden_id === customerId &&
    amsLookupIds.booking_id === bookingId;

  useEffect(() => {
    if (!enabled || !bridgeConfigured || !idsReady) {
      requestIdRef.current += 1;
      attemptedKeyRef.current = "";
      setStatus({ kind: "idle", text: "" });
      return;
    }

    if (idsMatchApplied) {
      requestIdRef.current += 1;
      setStatus({
        kind: "found",
        text: formatAmsLookupFoundLine(useKundeStore.getState().kunde),
      });
      return;
    }

    const key = lookupKey(customerId, bookingId);
    if (attemptedKeyRef.current === `${bridgeKey}\0${key}`) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (requestIdRef.current !== requestId) return;
        setStatus(AMS_LOOKUP_STATUS_SEARCHING);
        const attempts = await Promise.all(
          AMS_ID_LOOKUP_TYPES.map((markerType) =>
            lookupOne(customerId, bookingId, markerType),
          ),
        );
        if (requestIdRef.current !== requestId) return;

        const combined = combineAttempts(attempts);
        const attemptKey = `${bridgeKey}\0${key}`;
        if (combined.kind === "unreachable") {
          attemptedKeyRef.current = attemptKey;
          setStatus({ kind: "idle", text: "" });
          return;
        }
        if (combined.kind === "error") {
          attemptedKeyRef.current = attemptKey;
          setStatus({ kind: "error", text: combined.message });
          return;
        }
        if (combined.kind === "not_found") {
          attemptedKeyRef.current = attemptKey;
          setStatus(AMS_LOOKUP_STATUS_NOT_FOUND);
          return;
        }

        let picked: {
          customer: AmsBridgeCustomer;
          videoMode: "handcam" | "outside";
        };
        if (combined.kind === "choice") {
          const typeChoice = await askAmsTypeChoice({
            handcam: combined.handcam,
            outside: combined.outside,
          });
          if (requestIdRef.current !== requestId) return;
          if (typeChoice === "cancel") {
            attemptedKeyRef.current = attemptKey;
            setStatus({ kind: "idle", text: "" });
            return;
          }
          picked =
            typeChoice === "outside"
              ? { customer: combined.outside, videoMode: "outside" }
              : { customer: combined.handcam, videoMode: "handcam" };
        } else {
          picked = {
            customer: combined.customer,
            videoMode: combined.videoMode,
          };
        }

        const applied = await confirmAndApply(
          picked.customer,
          picked.videoMode,
          requestId,
          requestIdRef,
        );
        if (applied === "stale") return;
        attemptedKeyRef.current = attemptKey;
        if (applied === "kept") {
          setStatus({ kind: "idle", text: "" });
          return;
        }
        const appliedKunde = useKundeStore.getState().kunde;
        setStatus({
          kind: "found",
          text: formatAmsLookupFoundLine(appliedKunde),
        });
        showAmsLookupFoundToast(appliedKunde);
      })();
    }, AMS_LOOKUP_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (requestIdRef.current === requestId) {
        requestIdRef.current += 1;
      }
    };
  }, [
    enabled,
    bridgeConfigured,
    idsReady,
    customerId,
    bookingId,
    idsMatchApplied,
    bridgeKey,
  ]);

  if (idsMatchApplied && amsLookupRevision > 0) {
    return {
      kind: "found",
      text: formatAmsLookupFoundLine(kunde),
    };
  }
  return status;
}
