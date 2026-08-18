import { useEffect } from "react";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { AMS_HEALTH_POLL_MS } from "@/lib/amsBridgeStatus";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";

/** Background AMS health: boot check + quiet poll. No toasts. */
export function useAmsBridgeHealthPoll(enabled: boolean) {
  const config = useConfigStore((s) => s.config);
  const checkHealth = useAmsBridgeStore((s) => s.checkHealth);
  const reset = useAmsBridgeStore((s) => s.reset);
  const configured = isAmsBridgeConfigured(config);
  const url = config?.ams_bridge_url ?? "";
  const token = config?.ams_bridge_token ?? "";
  const lastOk = config?.ams_bridge_last_ok_url ?? "";

  useEffect(() => {
    if (!enabled) return;
    if (!configured) {
      reset();
      return;
    }
    void checkHealth();
    const id = window.setInterval(() => {
      if (useAmsBridgeStore.getState().phase === "checking") return;
      void checkHealth();
    }, AMS_HEALTH_POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, configured, url, token, lastOk, checkHealth, reset]);
}
