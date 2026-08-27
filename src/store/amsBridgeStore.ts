import { create } from "zustand";
import { tr } from "@/i18n";
import {
  computePathHintsDiff,
  diffPathHintsFromHealth,
  parsePathHintsFromHealth,
  type AmsPathHints,
  type AmsPathHintsDiff,
} from "@/lib/amsPathHints";
import {
  amsBridgeHealth,
  getConfig,
  type AmsBridgeHealthResult,
  type AppConfig,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";

export type AmsBridgePhase = "idle" | "checking" | "connected" | "error";

export type AmsHealthCheckOptions = {
  /** Keep last phase/label; only set `refreshing` (background poll). */
  quiet?: boolean;
};

type AmsBridgeState = {
  phase: AmsBridgePhase;
  connected: boolean;
  message: string;
  /** True during quiet background revalidation (label stays stable). */
  refreshing: boolean;
  baseUrl: string;
  version: string;
  displayName: string;
  serverInstanceId: string;
  capabilities: string[];
  /** Parsed AMS SMB hints (`paths-v1`); not persisted. */
  pathHints: AmsPathHints | null;
  /** Diff vs current config; updated on health + `refreshPathHintsDiff`. */
  pathHintsDiff: AmsPathHintsDiff | null;
  applyResult: (result: AmsBridgeHealthResult) => void;
  checkHealth: (
    opts?: AmsHealthCheckOptions,
  ) => Promise<AmsBridgeHealthResult>;
  /** Recompute diff when config changes (no health round-trip). */
  refreshPathHintsDiff: (config?: AppConfig | null) => void;
  reset: () => void;
};

/** Ignore stale results when a newer checkHealth started. */
let healthRequestSeq = 0;

function pathHintFields(
  health: AmsBridgeHealthResult["health"],
  config: AppConfig | null | undefined,
): Pick<AmsBridgeState, "pathHints" | "pathHintsDiff"> {
  const pathHints = parsePathHintsFromHealth(health);
  const pathHintsDiff = config
    ? diffPathHintsFromHealth(config, health)
    : null;
  return { pathHints, pathHintsDiff };
}

function resultFields(
  result: AmsBridgeHealthResult,
  config: AppConfig | null | undefined,
): Pick<
  AmsBridgeState,
  | "connected"
  | "message"
  | "phase"
  | "baseUrl"
  | "version"
  | "displayName"
  | "serverInstanceId"
  | "capabilities"
  | "pathHints"
  | "pathHintsDiff"
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
    ...pathHintFields(result.health, config),
  };
}

const EMPTY_PATH_HINTS: Pick<AmsBridgeState, "pathHints" | "pathHintsDiff"> = {
  pathHints: null,
  pathHintsDiff: null,
};

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
  refreshing: false,
  baseUrl: "",
  version: "",
  displayName: "",
  serverInstanceId: "",
  capabilities: [],
  pathHints: null,
  pathHintsDiff: null,

  applyResult: (result) => {
    const config = useConfigStore.getState().config;
    set({ ...resultFields(result, config), refreshing: false });
  },
  refreshPathHintsDiff: (config) => {
    const cfg = config ?? useConfigStore.getState().config;
    const currentHints = useAmsBridgeStore.getState().pathHints;
    if (!cfg || !currentHints) {
      set({ pathHintsDiff: null });
      return;
    }
    set({ pathHintsDiff: computePathHintsDiff(cfg, currentHints) });
  },
  checkHealth: async (opts) => {
    const quiet = Boolean(opts?.quiet);
    const seq = ++healthRequestSeq;
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
      const result = await amsBridgeHealth();
      if (seq !== healthRequestSeq) return result;
      const config = useConfigStore.getState().config;
      set({ ...resultFields(result, config), refreshing: false });
      if (result.ok) {
        await syncServerIdentityFromConfig();
      }
      return result;
    } catch (e) {
      const message = String(e);
      if (seq !== healthRequestSeq) {
        return { ok: false, message, health: null, base_url: "" };
      }
      set({
        connected: false,
        message,
        phase: "error",
        refreshing: false,
        baseUrl: "",
        version: "",
        displayName: "",
        serverInstanceId: "",
        capabilities: [],
        ...EMPTY_PATH_HINTS,
      });
      return { ok: false, message, health: null, base_url: "" };
    }
  },
  reset: () => {
    healthRequestSeq += 1;
    set({
      phase: "idle",
      connected: false,
      message: "",
      refreshing: false,
      baseUrl: "",
      version: "",
      displayName: "",
      serverInstanceId: "",
      capabilities: [],
      ...EMPTY_PATH_HINTS,
    });
  },
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
