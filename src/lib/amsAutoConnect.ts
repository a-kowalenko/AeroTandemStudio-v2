import { tr } from "@/i18n";
import type { AppConfig, AmsBridgeDiscovered, AmsBridgeHealthResult } from "@/lib/tauri";
import { amsBridgeDiscover, amsBridgeHealth, saveConfig } from "@/lib/tauri";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useUiStore } from "@/store/uiStore";

const AMS_DEFAULT_PORT = 8787;
const attemptedProbeFailures = new Set<string>();

function trimToEmpty(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function keyForCandidate(baseUrl: string, password: string): string {
  return `${baseUrl}\0${password}`;
}

function isTokenError(message: string): boolean {
  return /token\s+ungültig|401/i.test(message);
}

function isReachable(result: AmsBridgeHealthResult): boolean {
  return Boolean(result.ok && result.health?.online);
}

export function deriveAmsBaseUrlFromServerUrl(serverUrl: string): string | null {
  const raw = trimToEmpty(serverUrl);
  if (!raw) return null;

  if (/^smb:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const host = trimToEmpty(url.hostname);
      if (!host) return null;
      return `http://${host}:${AMS_DEFAULT_PORT}`;
    } catch {
      return null;
    }
  }

  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    const body = raw.replace(/^\\\\|^\/\//, "");
    const host = trimToEmpty(body.split(/[\\/]/)[0]);
    if (!host) return null;
    return `http://${host}:${AMS_DEFAULT_PORT}`;
  }

  return null;
}

async function checkCandidate(baseUrl: string, token: string): Promise<AmsBridgeHealthResult> {
  return amsBridgeHealth({ baseUrl, token });
}

async function askPickLanBridge(opts: {
  candidates: AmsBridgeDiscovered[];
  derivedBaseUrl: string | null;
}): Promise<string | null> {
  const { candidates, derivedBaseUrl } = opts;
  if (!candidates.length) return null;

  // Order: derived match first, then stable fallback.
  const ordered = [...candidates].sort((a, b) => {
    const aHit = derivedBaseUrl && trimToEmpty(a.base_url) === trimToEmpty(derivedBaseUrl);
    const bHit = derivedBaseUrl && trimToEmpty(b.base_url) === trimToEmpty(derivedBaseUrl);
    if (aHit && !bHit) return -1;
    if (!aHit && bHit) return 1;
    return a.base_url.localeCompare(b.base_url);
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (baseUrl: string | null) => {
      if (settled) return;
      settled = true;
      useUiStore.getState().closeDialog();
      resolve(baseUrl);
    };

    useUiStore.getState().showSuccess(
      "Mehrere Buchungssuchen (AMS) im LAN gefunden.\nBitte wählen, welche Instanz verwendet werden soll.",
      tr("settings.server.ams.operatorTitle"),
      {
        autoCloseSecs: 0,
        choices: {
          options: ordered.map((c) => {
            const id = `${c.base_url}\0${c.instance}`;
            const v = c.version?.trim();
            const meta = v ? ` (v${v})` : "";
            return {
              id,
              label: c.instance ? `${c.instance}` : c.base_url,
              detail: `${c.base_url}${meta}`,
            };
          }),
          cancelLabel: "Abbrechen",
          onPick: (id) => {
            const baseUrl = id.split("\0")[0];
            finish(baseUrl || null);
          },
          onCancel: () => finish(null),
        },
      },
    );
  });
}

async function discoverLanCandidates(): Promise<AmsBridgeDiscovered[]> {
  return amsBridgeDiscover(3);
}

async function persistConnectedConfig(next: AppConfig): Promise<AppConfig | null> {
  const saved = await saveConfig(next);
  useConfigStore.getState().updateLocal(saved);
  return saved;
}

export async function runAmsAutoConnect(opts: {
  config: AppConfig;
  interactive?: boolean;
}): Promise<"connected" | "skipped" | "needs_token" | "not_found"> {
  const config = opts.config;
  const interactive = opts.interactive ?? false;
  const currentToken = trimToEmpty(config.ams_bridge_token);
  const serverPassword = config.server_password;
  const hasStoredToken = currentToken.length > 0;
  const fallbackAllowed = !hasStoredToken && trimToEmpty(serverPassword).length > 0;

  if (trimToEmpty(config.ams_bridge_url) && hasStoredToken) {
    return "skipped";
  }

  const candidates: string[] = [];
  const derived = deriveAmsBaseUrlFromServerUrl(config.server_url);
  if (derived) candidates.push(derived);
  const configured = trimToEmpty(config.ams_bridge_url);
  if (configured && !candidates.includes(configured)) candidates.push(configured);
  const lastOk = trimToEmpty(config.ams_bridge_last_ok_url);
  if (lastOk && !candidates.includes(lastOk)) candidates.push(lastOk);

  let chosenBaseUrl: string | null = null;
  let usedFallbackPassword = false;

  for (const baseUrl of candidates) {
    if (hasStoredToken) {
      const result = await checkCandidate(baseUrl, currentToken);
      if (isReachable(result)) {
        chosenBaseUrl = baseUrl;
        useAmsBridgeStore.getState().applyResult(result);
        break;
      }
    }
    if (!fallbackAllowed) continue;
    const probeKey = keyForCandidate(baseUrl, serverPassword);
    if (attemptedProbeFailures.has(probeKey)) continue;
    const result = await checkCandidate(baseUrl, serverPassword);
    if (isReachable(result)) {
      chosenBaseUrl = baseUrl;
      usedFallbackPassword = true;
      useAmsBridgeStore.getState().applyResult(result);
      break;
    }
    if (isTokenError(result.message)) {
      attemptedProbeFailures.add(probeKey);
      if (interactive) {
        useUiStore.getState().showError(
          tr("ams.status.tokenInvalidLabel") + "\n\n" + tr("ams.status.tokenAuthHint"),
          tr("settings.server.ams.operatorTitle"),
          {
            primaryAction: {
              label: tr("ams.actions.checkToken"),
              openSettings: { tab: "server", focus: "ams-bridge-token" },
            },
          },
        );
      }
      return "needs_token";
    }
  }

  if (!chosenBaseUrl) {
    const discoveredList = await discoverLanCandidates();
    if (!discoveredList.length) return "not_found";

    let discoveredBaseUrl: string | null = null;

    if (discoveredList.length === 1) {
      discoveredBaseUrl = discoveredList[0].base_url;
    } else if (interactive) {
      discoveredBaseUrl = await askPickLanBridge({
        candidates: discoveredList,
        derivedBaseUrl: derived,
      });
    }

    if (!discoveredBaseUrl) return "not_found";
    if (hasStoredToken) {
      const result = await checkCandidate(discoveredBaseUrl, currentToken);
      if (isReachable(result)) {
        chosenBaseUrl = discoveredBaseUrl;
        useAmsBridgeStore.getState().applyResult(result);
      }
    }
    if (!chosenBaseUrl && fallbackAllowed) {
      const probeKey = keyForCandidate(discoveredBaseUrl, serverPassword);
      if (!attemptedProbeFailures.has(probeKey)) {
        const result = await checkCandidate(discoveredBaseUrl, serverPassword);
        if (isReachable(result)) {
          chosenBaseUrl = discoveredBaseUrl;
          usedFallbackPassword = true;
          useAmsBridgeStore.getState().applyResult(result);
        } else if (isTokenError(result.message)) {
          attemptedProbeFailures.add(probeKey);
          if (interactive) {
            useUiStore.getState().showError(
              tr("ams.status.tokenInvalidLabel") + "\n\n" + tr("ams.status.tokenAuthHint"),
              tr("settings.server.ams.operatorTitle"),
              {
                primaryAction: {
                  label: tr("ams.actions.checkToken"),
                  openSettings: { tab: "server", focus: "ams-bridge-token" },
                },
              },
            );
          }
          return "needs_token";
        }
      }
    }
    if (!chosenBaseUrl) return "not_found";
  }

  const nextConfig: AppConfig = {
    ...config,
    ams_bridge_url: chosenBaseUrl,
    ams_bridge_last_ok_url: chosenBaseUrl,
    ams_bridge_token: usedFallbackPassword ? serverPassword : config.ams_bridge_token,
  };
  const saved = await persistConnectedConfig(nextConfig);
  if (saved && usedFallbackPassword && interactive) {
    useUiStore
      .getState()
      .showSuccess(tr("ams.status.healthOk"), tr("settings.server.ams.operatorTitle"));
  }
  return "connected";
}
