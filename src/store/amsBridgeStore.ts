import { create } from "zustand";
import {
  amsBridgeHealth,
  type AmsBridgeHealthResult,
} from "@/lib/tauri";

export type AmsBridgePhase = "idle" | "checking" | "connected" | "error";

type AmsBridgeState = {
  phase: AmsBridgePhase;
  connected: boolean;
  message: string;
  baseUrl: string;
  version: string;
  capabilities: string[];
  applyResult: (result: AmsBridgeHealthResult) => void;
  checkHealth: () => Promise<AmsBridgeHealthResult>;
  reset: () => void;
};

function resultFields(result: AmsBridgeHealthResult): Pick<
  AmsBridgeState,
  "connected" | "message" | "phase" | "baseUrl" | "version" | "capabilities"
> {
  return {
    connected: result.ok,
    message: result.message,
    phase: result.ok ? "connected" : "error",
    baseUrl: result.base_url,
    version: result.health?.version ?? "",
    capabilities: result.health?.capabilities ?? [],
  };
}

export const useAmsBridgeStore = create<AmsBridgeState>((set) => ({
  phase: "idle",
  connected: false,
  message: "",
  baseUrl: "",
  version: "",
  capabilities: [],

  applyResult: (result) => set(resultFields(result)),
  checkHealth: async () => {
    set({ phase: "checking", message: "Prüfe…" });
    try {
      const result = await amsBridgeHealth();
      set(resultFields(result));
      return result;
    } catch (e) {
      const message = String(e);
      set({
        connected: false,
        message,
        phase: "error",
        baseUrl: "",
        version: "",
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
      capabilities: [],
    }),
}));
