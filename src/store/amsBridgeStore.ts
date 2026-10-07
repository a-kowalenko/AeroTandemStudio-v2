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
  type CloudLookupProbeResult,
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
  /**
   * Last Cloud Lookup probe for header chip:
   * `null` = unknown (JWT alone is optimistic green),
   * `true`/`false` = last probe result.
   */
  cloudProbeOk: boolean | null;
  applyResult: (result: AmsBridgeHealthResult) => void;
  checkHealth: (
    opts?: AmsHealthCheckOptions,
  ) => Promise<AmsBridgeHealthResult>;
  /** Recompute diff when config changes (no health round-trip). */
  refreshPathHintsDiff: (config?: AppConfig | null) => void;
  applyCloudProbe: (probe: CloudLookupProbeResult) => void;
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

/** Sync AMS identity + Cloud JWT fields after health (backend may have refreshed token). */
async function syncBridgeConfigFromBackend(): Promise<void> {
  try {
    const cfg = await getConfig();
    const current = useConfigStore.getState().config;
    if (!current) return;
    const patch: Partial<AppConfig> = {};
    if (current.ams_bridge_display_name !== cfg.ams_bridge_display_name) {
      patch.ams_bridge_display_name = cfg.ams_bridge_display_name;
    }
    if (current.ams_bridge_server_instance_id !== cfg.ams_bridge_server_instance_id) {
      patch.ams_bridge_server_instance_id = cfg.ams_bridge_server_instance_id;
    }
    // Phase 53 / T3: keep gate/UI in sync with persisted Cloud JWT.
    if (current.cloud_lookup_access_token !== cfg.cloud_lookup_access_token) {
      patch.cloud_lookup_access_token = cfg.cloud_lookup_access_token;
    }
    if (current.cloud_lookup_expires_at !== cfg.cloud_lookup_expires_at) {
      patch.cloud_lookup_expires_at = cfg.cloud_lookup_expires_at;
    }
    if (current.cloud_lookup_cloud_base_url !== cfg.cloud_lookup_cloud_base_url) {
      patch.cloud_lookup_cloud_base_url = cfg.cloud_lookup_cloud_base_url;
    }
    if (
      current.cloud_lookup_ams_server_instance_id !==
      cfg.cloud_lookup_ams_server_instance_id
    ) {
      patch.cloud_lookup_ams_server_instance_id =
        cfg.cloud_lookup_ams_server_instance_id;
    }
    if (Object.keys(patch).length === 0) return;
    useConfigStore.getState().updateLocal(patch);
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
  cloudProbeOk: null,

  applyResult: (result) => {
    const config = useConfigStore.getState().config;
    set({
      ...resultFields(result, config),
      refreshing: false,
      // AMS up again → clear stale Cloud-down latch until next probe.
      ...(result.ok ? { cloudProbeOk: null as boolean | null } : {}),
    });
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
  applyCloudProbe: (probe) => {
    if (probe.status === "no_token") {
      set({ cloudProbeOk: false });
      return;
    }
    set({ cloudProbeOk: probe.ok });
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
      set({
        ...resultFields(result, config),
        refreshing: false,
        ...(result.ok ? { cloudProbeOk: null as boolean | null } : {}),
      });
      // Always sync Cloud JWT fields (refresh on ok; unchanged/cleared otherwise).
      await syncBridgeConfigFromBackend();
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
      cloudProbeOk: null,
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
