import { create } from "zustand";
import { tr } from "@/i18n";
import {
  testServerConnection,
  type ConnectionTestResult,
  type UploadProgressEvent,
} from "@/lib/tauri";

export type ServerPhase = "idle" | "checking" | "connected" | "error" | "uploading";

export type ServerConnectionCheckOptions = {
  /** Keep last phase/label; only set `refreshing` (background poll). */
  quiet?: boolean;
  server_url?: string;
  server_login?: string;
  server_password?: string;
};

type ServerState = {
  phase: ServerPhase;
  connected: boolean;
  message: string;
  /** True during quiet background revalidation (label stays stable). */
  refreshing: boolean;
  uploadProgress: UploadProgressEvent | null;
  setPhase: (phase: ServerPhase) => void;
  setUploadProgress: (p: UploadProgressEvent | null) => void;
  applyTestResult: (result: ConnectionTestResult) => void;
  checkConnection: (
    opts?: ServerConnectionCheckOptions,
  ) => Promise<ConnectionTestResult>;
  reset: () => void;
};

/** Ignore stale results when a newer checkConnection started. */
let connectionRequestSeq = 0;

export const useServerStore = create<ServerState>((set) => ({
  phase: "idle",
  connected: false,
  message: "",
  refreshing: false,
  uploadProgress: null,

  setPhase: (phase) => {
    if (phase === "uploading") {
      // Invalidate in-flight quiet/loud checks so they cannot overwrite upload state.
      connectionRequestSeq += 1;
      set({ phase, refreshing: false });
      return;
    }
    set({ phase });
  },
  setUploadProgress: (uploadProgress) => set({ uploadProgress }),
  applyTestResult: (result) =>
    set({
      connected: result.ok,
      message: result.message,
      phase: result.ok ? "connected" : "error",
      refreshing: false,
    }),
  checkConnection: async (opts) => {
    const quiet = Boolean(opts?.quiet);
    const overrides =
      opts?.server_url !== undefined ||
      opts?.server_login !== undefined ||
      opts?.server_password !== undefined
        ? {
            server_url: opts.server_url,
            server_login: opts.server_login,
            server_password: opts.server_password,
          }
        : undefined;
    const seq = ++connectionRequestSeq;
    if (quiet) {
      set({ refreshing: true });
    } else {
      set({
        phase: "checking",
        message: tr("common.actions.checking"),
        refreshing: false,
      });
    }
    try {
      const result = await testServerConnection(overrides);
      if (seq !== connectionRequestSeq) return result;
      set({
        connected: result.ok,
        message: result.message,
        phase: result.ok ? "connected" : "error",
        refreshing: false,
      });
      return result;
    } catch (e) {
      const message = String(e);
      if (seq !== connectionRequestSeq) {
        return { ok: false, message };
      }
      set({ connected: false, message, phase: "error", refreshing: false });
      return { ok: false, message };
    }
  },
  reset: () => {
    connectionRequestSeq += 1;
    set({
      phase: "idle",
      connected: false,
      message: "",
      refreshing: false,
      uploadProgress: null,
    });
  },
}));
