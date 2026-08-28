import { useEffect, useState } from "react";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { isPostUpdateConnectionFailure } from "@/lib/postUpdateConnectionHint";
import { saveConfig } from "@/lib/tauri";
import { isMacOsHost } from "@/lib/utils";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";

const OPEN_DELAY_MS = 500;

export function usePostUpdateConnectionHint(opts: {
  enabled: boolean;
  appVersion: string;
  backupPopoverActive: boolean;
}): {
  open: boolean;
  acknowledge: () => Promise<void>;
} {
  const { enabled, appVersion, backupPopoverActive } = opts;

  const config = useConfigStore((s) => s.config);
  const smbPhase = useServerStore((s) => s.phase);
  const smbConnected = useServerStore((s) => s.connected);
  const smbMessage = useServerStore((s) => s.message);
  const smbRefreshing = useServerStore((s) => s.refreshing);
  const amsPhase = useAmsBridgeStore((s) => s.phase);
  const amsConnected = useAmsBridgeStore((s) => s.connected);
  const amsMessage = useAmsBridgeStore((s) => s.message);
  const amsRefreshing = useAmsBridgeStore((s) => s.refreshing);

  const serverUrl = config?.server_url ?? "";
  const amsConfigured = isAmsBridgeConfigured(config);
  const pendingVersion = (config?.post_update_hint_pending_version ?? "").trim();
  const ackVersion = (config?.post_update_hint_ack_version ?? "").trim();

  const pendingActive =
    pendingVersion.length > 0 && pendingVersion === appVersion.trim();
  const hintEligible = pendingActive && ackVersion !== appVersion.trim();

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (
      !enabled ||
      !isMacOsHost() ||
      !hintEligible ||
      backupPopoverActive
    ) {
      setOpen(false);
      return;
    }

    if (
      !isPostUpdateConnectionFailure({
        serverUrl,
        smbPhase,
        smbConnected,
        smbMessage,
        smbRefreshing,
        amsConfigured,
        amsPhase,
        amsConnected,
        amsMessage,
        amsRefreshing,
      })
    ) {
      setOpen(false);
      return;
    }

    const id = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [
    enabled,
    hintEligible,
    backupPopoverActive,
    appVersion,
    serverUrl,
    smbPhase,
    smbConnected,
    smbMessage,
    smbRefreshing,
    amsConfigured,
    amsPhase,
    amsConnected,
    amsMessage,
    amsRefreshing,
  ]);

  async function acknowledge() {
    if (!config) {
      setOpen(false);
      return;
    }
    try {
      const saved = await saveConfig({
        ...config,
        post_update_hint_ack_version: appVersion,
        post_update_hint_pending_version: "",
      });
      useConfigStore.getState().updateLocal(saved);
    } catch {
      /* best-effort persist */
    }
    setOpen(false);
  }

  return { open, acknowledge };
}
