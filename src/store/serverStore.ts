import { create } from "zustand";
import { tr } from "@/i18n";
import { smbHostsMatch, type SmbHealthEvent } from "@/lib/smbHealthPoll";
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
  /**
   * A real Login + Share check (or transfer) succeeded since the last failure.
   * Quiet TCP-OK only proves the server answers and leaves this unchanged.
   */
  loginVerified: boolean;
  /** True during quiet background revalidation (label stays stable). */
  refreshing: boolean;
  uploadProgress: UploadProgressEvent | null;
  setPhase: (phase: ServerPhase) => void;
  setUploadProgress: (p: UploadProgressEvent | null) => void;
  applyTestResult: (result: ConnectionTestResult) => void;
  /** OPT-23E piggyback. Returns false when `host` is not the configured server. */
  applyTransferHealth: (
    event: SmbHealthEvent,
    configuredHost: string | null,
  ) => boolean;
  checkConnection: (
    opts?: ServerConnectionCheckOptions,
  ) => Promise<ConnectionTestResult>;
  reset: () => void;
};

/** Ignore stale results when a newer checkConnection started. */
let connectionRequestSeq = 0;

export function nextLoginVerified(
  prev: boolean,
  result: Pick<ConnectionTestResult, "ok" | "login_unverified">,
): boolean {
  if (!result.ok) return false;
  return result.login_unverified ? prev : true;
}

export const useServerStore = create<ServerState>((set, get) => ({
  phase: "idle",
  connected: false,
  message: "",
  loginVerified: false,
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
      loginVerified: nextLoginVerified(get().loginVerified, result),
      phase: result.ok ? "connected" : "error",
      refreshing: false,
    }),
  applyTransferHealth: (event, configuredHost) => {
    if (!smbHostsMatch(event.host, configuredHost)) return false;
    // Drop an in-flight quiet check so it cannot overwrite this sample.
    connectionRequestSeq += 1;
    const phase = get().phase;
    if (phase === "uploading") {
      // Keep the upload chip until the slot runner sets the final phase.
      set({
        connected: event.ok,
        message: event.message,
        loginVerified: event.ok,
        refreshing: false,
      });
      return true;
    }
    set({
      connected: event.ok,
      message: event.message,
      loginVerified: event.ok,
      phase: event.ok ? "connected" : "error",
      refreshing: false,
    });
    return true;
  },
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
      const result = await testServerConnection(overrides, quiet);
      if (seq !== connectionRequestSeq) return result;
      // OPT-20B Quiet-Poll: map still waking — keep last phase/label.
      if (quiet && result.soft_hold) {
        set({ refreshing: false });
        return result;
      }
      set({
        connected: result.ok,
        message: result.message,
        loginVerified: nextLoginVerified(get().loginVerified, result),
        phase: result.ok ? "connected" : "error",
        refreshing: false,
      });
      return result;
    } catch (e) {
      const message = String(e);
      if (seq !== connectionRequestSeq) {
        return { ok: false, message };
      }
      // Quiet: do not flip to red on invoke errors during reconnect window.
      if (quiet) {
        set({ refreshing: false });
        return { ok: false, message, soft_hold: true };
      }
      set({
        connected: false,
        message,
        loginVerified: false,
        phase: "error",
        refreshing: false,
      });
      return { ok: false, message };
    }
  },
  reset: () => {
    connectionRequestSeq += 1;
    set({
      phase: "idle",
      connected: false,
      message: "",
      loginVerified: false,
      refreshing: false,
      uploadProgress: null,
    });
  },
}));
