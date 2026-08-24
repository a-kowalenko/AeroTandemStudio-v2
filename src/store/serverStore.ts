import { create } from "zustand";
import { tr } from "@/i18n";
import {
  testServerConnection,
  type ConnectionTestResult,
  type UploadProgressEvent,
} from "@/lib/tauri";

export type ServerPhase = "idle" | "checking" | "connected" | "error" | "uploading";

type ServerState = {
  phase: ServerPhase;
  connected: boolean;
  message: string;
  uploadProgress: UploadProgressEvent | null;
  setPhase: (phase: ServerPhase) => void;
  setUploadProgress: (p: UploadProgressEvent | null) => void;
  applyTestResult: (result: ConnectionTestResult) => void;
  checkConnection: (overrides?: {
    server_url?: string;
    server_login?: string;
    server_password?: string;
  }) => Promise<ConnectionTestResult>;
  reset: () => void;
};

export const useServerStore = create<ServerState>((set) => ({
  phase: "idle",
  connected: false,
  message: "",
  uploadProgress: null,

  setPhase: (phase) => set({ phase }),
  setUploadProgress: (uploadProgress) => set({ uploadProgress }),
  applyTestResult: (result) =>
    set({
      connected: result.ok,
      message: result.message,
      phase: result.ok ? "connected" : "error",
    }),
  checkConnection: async (overrides) => {
    set({ phase: "checking", message: tr("common.actions.checking") });
    try {
      const result = await testServerConnection(overrides);
      set({
        connected: result.ok,
        message: result.message,
        phase: result.ok ? "connected" : "error",
      });
      return result;
    } catch (e) {
      const message = String(e);
      set({ connected: false, message, phase: "error" });
      return { ok: false, message };
    }
  },
  reset: () =>
    set({
      phase: "idle",
      connected: false,
      message: "",
      uploadProgress: null,
    }),
}));
