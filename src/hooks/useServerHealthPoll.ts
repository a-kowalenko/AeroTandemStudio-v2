import { useEffect } from "react";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { AMS_HEALTH_POLL_MS } from "@/lib/amsBridgeStatus";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";

function canStartQuietAmsPoll(): boolean {
  const { phase, refreshing } = useAmsBridgeStore.getState();
  return phase !== "checking" && !refreshing;
}

function canStartQuietSmbPoll(): boolean {
  const { phase, refreshing } = useServerStore.getState();
  return phase !== "checking" && phase !== "uploading" && !refreshing;
}

function runQuietAmsHealthCheck(): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return;
  }
  if (!canStartQuietAmsPoll()) return;
  void useAmsBridgeStore.getState().checkHealth({ quiet: true });
}

function runQuietSmbHealthCheck(): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return;
  }
  if (!canStartQuietSmbPoll()) return;
  void useServerStore.getState().checkConnection({ quiet: true });
}

/**
 * Shared SMB + AMS health: loud boot check + quiet 45s / visibility poll.
 * Independent per path — no cross-triggers, no auto-upload.
 */
export function useServerHealthPoll(enabled: boolean) {
  const config = useConfigStore((s) => s.config);

  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);
  const resetAms = useAmsBridgeStore((s) => s.reset);
  const amsConfigured = isAmsBridgeConfigured(config);
  const amsUrl = config?.ams_bridge_url ?? "";
  const amsToken = config?.ams_bridge_token ?? "";
  const amsLastOk = config?.ams_bridge_last_ok_url ?? "";
  const amsDisplayName = config?.ams_bridge_display_name ?? "";

  const checkSmbConnection = useServerStore((s) => s.checkConnection);
  const resetSmb = useServerStore((s) => s.reset);
  const serverUrl = config?.server_url ?? "";
  const serverLogin = config?.server_login ?? "";
  const serverPassword = config?.server_password ?? "";
  const smbConfigured = Boolean(serverUrl.trim());

  useEffect(() => {
    if (!enabled) return;
    if (!amsConfigured) {
      resetAms();
      return;
    }
    void checkAmsHealth();
    const id = window.setInterval(() => {
      runQuietAmsHealthCheck();
    }, AMS_HEALTH_POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        runQuietAmsHealthCheck();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    enabled,
    amsConfigured,
    amsUrl,
    amsToken,
    amsLastOk,
    amsDisplayName,
    checkAmsHealth,
    resetAms,
  ]);

  useEffect(() => {
    if (!enabled) return;
    if (!smbConfigured) {
      resetSmb();
      return;
    }
    void checkSmbConnection();
    const id = window.setInterval(() => {
      runQuietSmbHealthCheck();
    }, AMS_HEALTH_POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        runQuietSmbHealthCheck();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    enabled,
    smbConfigured,
    serverUrl,
    serverLogin,
    serverPassword,
    checkSmbConnection,
    resetSmb,
  ]);
}
