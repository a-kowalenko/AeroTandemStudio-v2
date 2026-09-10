/** Confirm + run AMS `mode=id` lookup; discard stale responses. */

import { useEffect, useRef, useState } from "react";
import {
  AMS_LOOKUP_DEBOUNCE_MS,
  amsLookupFoundTitle,
  amsLookupStatusNotFound,
  amsLookupStatusSearching,
  askAmsTypeChoice,
  canRunAmsIdLookup,
  formatAmsLookupFoundLine,
  formatTypeChoiceDetail,
  isAmsBridgeConfigured,
  isLookupIdPairReady,
  needsAmsLookupOverrideConfirm,
  type AmsBridgeCustomer,
  type AmsLookupStatus,
} from "@/lib/amsLookup";
import { runAmsIdPairLookup } from "@/lib/amsIdLookupCore";
import { tr } from "@/i18n";
import { type AppConfig } from "@/lib/tauri";
import { showAmsLookupFoundToast } from "@/lib/amsLookupToast";
import { kundeDisplayName } from "@/lib/qrSuccess";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useKundeStore } from "@/store/kundeStore";
import { useUiStore } from "@/store/uiStore";

function lookupKey(customerId: string, bookingId: string): string {
  return `${customerId}\0${bookingId}`;
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
    const previous = opts.previousLabel.trim() || tr("qr.confirm.manualEntry");
    const next = opts.nextName.trim() || tr("qr.confirm.newCustomer");
    useUiStore.getState().showSuccess(
      tr("ams.lookup.overrideBody", { previous, next }),
      amsLookupFoundTitle(),
      {
        highlight: next,
        autoCloseSecs: 0,
        confirm: {
          secondaryLabel: tr("ams.lookup.keep"),
          primaryLabel: tr("ams.lookup.apply"),
          onSecondary: () => finish("keep"),
          onPrimary: () => finish("apply"),
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
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsCapabilities = useAmsBridgeStore((s) => s.capabilities);
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
  const lookupLive = canRunAmsIdLookup({
    configured: bridgeConfigured,
    connected: amsConnected,
    capabilities: amsCapabilities,
  });
  const bridgeKey = `${config?.ams_bridge_url ?? ""}\0${config?.ams_bridge_token ?? ""}\0${config?.ams_bridge_last_ok_url ?? ""}`;
  const idsMatchApplied =
    amsLookupIds != null &&
    amsLookupIds.kunden_id === customerId &&
    amsLookupIds.booking_id === bookingId;

  useEffect(() => {
    const markSettled = () => useKundeStore.getState().markAmsLookupSettled();

    if (!enabled || !lookupLive || !idsReady) {
      requestIdRef.current += 1;
      attemptedKeyRef.current = "";
      setStatus({ kind: "idle", text: "" });
      if (idsReady && (!enabled || !lookupLive)) {
        markSettled();
      }
      return;
    }

    if (idsMatchApplied) {
      requestIdRef.current += 1;
      markSettled();
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
        setStatus(amsLookupStatusSearching());
        const combined = await runAmsIdPairLookup(customerId, bookingId);
        if (requestIdRef.current !== requestId) return;

        const attemptKey = `${bridgeKey}\0${key}`;
        if (combined.kind === "unreachable") {
          attemptedKeyRef.current = attemptKey;
          markSettled();
          setStatus({ kind: "idle", text: "" });
          return;
        }
        if (combined.kind === "error") {
          attemptedKeyRef.current = attemptKey;
          markSettled();
          setStatus({ kind: "error", text: combined.message });
          return;
        }
        if (combined.kind === "not_found") {
          attemptedKeyRef.current = attemptKey;
          markSettled();
          setStatus(amsLookupStatusNotFound());
          return;
        }

        let picked: {
          customer: AmsBridgeCustomer;
          videoMode: "handcam" | "outside";
        };
        if (combined.kind === "choice") {
          const typeChoice = await askAmsTypeChoice({
            handcamDetail: formatTypeChoiceDetail(combined.handcam, "handcam"),
            outsideDetail: formatTypeChoiceDetail(combined.outside, "outside"),
          });
          if (requestIdRef.current !== requestId) return;
          if (typeChoice === "cancel") {
            attemptedKeyRef.current = attemptKey;
            markSettled();
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
        markSettled();
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
    lookupLive,
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
