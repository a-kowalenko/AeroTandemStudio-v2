import { create } from "zustand";
import { tr } from "@/i18n";
import {
  amsBridgeHealth,
  getConfig,
  type AmsBridgeHealthResult,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";

export type AmsBridgePhase = "idle" | "checking" | "connected" | "error";

type AmsBridgeState = {
  phase: AmsBridgePhase;
  connected: boolean;
  message: string;
  baseUrl: string;
  version: string;
  displayName: string;
  serverInstanceId: string;
  capabilities: string[];
  applyResult: (result: AmsBridgeHealthResult) => void;
  checkHealth: () => Promise<AmsBridgeHealthResult>;
  reset: () => void;
};

function resultFields(result: AmsBridgeHealthResult): Pick<
  AmsBridgeState,
  | "connected"
  | "message"
  | "phase"
  | "baseUrl"
  | "version"
  | "displayName"
  | "serverInstanceId"
  | "capabilities"
> {
  return {
    connected: result.ok,
    message: result.message,
    phase: result.ok ? "connected" : "error",
    baseUrl: result.base_url,
    version: result.health?.version ?? "",
    displayName: result.health?.display_name?.trim() ?? "",
    serverInstanceId: result.health?.instance_id?.trim() ?? "",
    capabilities: result.health?.capabilities ?? [],
  };
}

async function syncServerIdentityFromConfig(): Promise<void> {
  try {
    const cfg = await getConfig();
    useConfigStore.getState().updateLocal({
      ams_bridge_display_name: cfg.ams_bridge_display_name,
      ams_bridge_server_instance_id: cfg.ams_bridge_server_instance_id,
    });
  } catch {
    // Best-effort after backend persist.
  }
}

export const useAmsBridgeStore = create<AmsBridgeState>((set) => ({
  phase: "idle",
  connected: false,
  message: "",
  baseUrl: "",
  version: "",
  displayName: "",
  serverInstanceId: "",
  capabilities: [],

  applyResult: (result) => set(resultFields(result)),
  checkHealth: async () => {
    set({ phase: "checking", message: tr("common.actions.checking") });
    try {
      const result = await amsBridgeHealth();
      set(resultFields(result));
      if (result.ok) {
        await syncServerIdentityFromConfig();
      }
      return result;
    } catch (e) {
      const message = String(e);
      set({
        connected: false,
        message,
        phase: "error",
        baseUrl: "",
        version: "",
        displayName: "",
        serverInstanceId: "",
        capabilities: [],
      });
      return { ok: false, message, health: null, base_url: "" };
    }
  },
  reset: () =>
    set({
      phase: "idle",
      connected: false,
      message: "",
      baseUrl: "",
      version: "",
      displayName: "",
      serverInstanceId: "",
      capabilities: [],
    }),
}));

export function discoveredAmsLabel(item: {
  display_name?: string;
  instance?: string;
  base_url: string;
}): string {
  const name = item.display_name?.trim();
  if (name) return name;
  const inst = item.instance?.trim();
  if (inst) return inst;
  return item.base_url;
}
