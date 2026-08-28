import { useEffect, useRef } from "react";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { AMS_HANDOFF_POLL_BATCH, AMS_HANDOFF_POLL_MS } from "@/lib/amsHandoffPoll";
import { useHandoffSync, runHandoffSyncBatch } from "@/hooks/useHandoffSync";
import { useConfigStore } from "@/store/configStore";

function canPollHandoff(config: {
  upload_to_server?: boolean;
  server_url?: string | null;
  ams_bridge_url?: string | null;
  ams_bridge_last_ok_url?: string | null;
} | null): boolean {
  if (!config?.upload_to_server) return false;
  const smb = Boolean((config.server_url ?? "").trim());
  const bridge = isAmsBridgeConfigured(config);
  return smb || bridge;
}

/**
 * Background AMS handoff poll (~45s, round-robin) + boot sync via {@link useHandoffSync}.
 * Syncs unsettled jobs even when the local job folder was removed after upload.
 */
export function useAmsHandoffPoll(enabled: boolean): void {
  const config = useConfigStore((s) => s.config);
  const pollEnabled = enabled && canPollHandoff(config);
  const cursorRef = useRef(0);

  useHandoffSync(pollEnabled, { eager: true });

  useEffect(() => {
    if (!pollEnabled) {
      cursorRef.current = 0;
      return;
    }

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void runHandoffSyncBatch(AMS_HANDOFF_POLL_BATCH, cursorRef);
    };

    const start = window.setTimeout(tick, 2_000);
    const id = window.setInterval(tick, AMS_HANDOFF_POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearTimeout(start);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    pollEnabled,
    config?.upload_to_server,
    config?.server_url,
    config?.ams_bridge_url,
    config?.ams_bridge_last_ok_url,
  ]);
}
