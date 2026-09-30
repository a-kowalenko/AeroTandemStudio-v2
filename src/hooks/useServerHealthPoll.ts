import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { AMS_HEALTH_POLL_MS } from "@/lib/amsBridgeStatus";
import {
  jitteredPollDelay,
  smbHostFromServerUrl,
  SMB_LOUD_AFTER_HIDDEN_MS,
  type SmbHealthEvent,
} from "@/lib/smbHealthPoll";
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

/** Boot / manual stay loud at the call site. A long hide re-checks Login + Share. */
function runVisibilitySmbHealthCheck(hiddenMs: number): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return;
  }
  const { phase } = useServerStore.getState();
  if (phase === "uploading") return;
  if (hiddenMs > SMB_LOUD_AFTER_HIDDEN_MS) {
    if (phase === "checking") return;
    void useServerStore.getState().checkConnection();
    return;
  }
  runQuietSmbHealthCheck();
}

/**
 * Shared SMB + AMS health: loud boot check + quiet poll / visibility.
 * SMB quiet interval is 45s ±10 %. Hidden longer than 10 min triggers a loud
 * SMB check. Transfer results (`smb-health`) reset that timer.
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
    let stopped = false;
    let timer = 0;
    let hiddenAt = 0;
    let unlisten: (() => void) | undefined;
    const configuredHost = smbHostFromServerUrl(serverUrl);

    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped) return;
      timer = window.setTimeout(() => {
        runQuietSmbHealthCheck();
        schedule();
      }, jitteredPollDelay(AMS_HEALTH_POLL_MS));
    };

    void checkSmbConnection();
    schedule();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const hiddenMs = hiddenAt > 0 ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      runVisibilitySmbHealthCheck(hiddenMs);
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    listen<SmbHealthEvent>("smb-health", (event) => {
      const applied = useServerStore
        .getState()
        .applyTransferHealth(event.payload, configuredHost);
      if (applied) schedule();
    })
      .then((fn) => {
        if (stopped) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Browser preview / backend not ready
      });

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
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
