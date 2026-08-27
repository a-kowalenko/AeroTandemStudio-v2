import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { applyAmsPathHintsWithCredentials } from "@/lib/amsPathHintsCredentialsFlow";
import {
  bindPathHintsServerInstance,
  isPlaceholderServerUrl,
  parsePathHintsFromHealth,
} from "@/lib/amsPathHintsCore";
import {
  presentServerConnectionError,
  serverConnectionStatusLabel,
} from "@/lib/serverStatus";
import {
  DEFAULT_SERVER_PROFILE_ID,
  GERA_SERVER_PROFILE_ID,
  PRESET_SERVER_PROFILE_LABELS,
  patchActiveServerProfileLabel,
  patchServerConnection,
  switchServerProfile,
} from "@/lib/serverProfile";
import {
  amsBridgeDiscover,
  amsBridgeHealth,
  type AmsBridgeDiscovered,
  type AppConfig,
} from "@/lib/tauri";
import { discoveredAmsLabel, useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useServerStore } from "@/store/serverStore";
import { cn } from "@/lib/utils";

type Mode = "ams" | "manual";

type Props = {
  draft: AppConfig;
  setDraft: (next: AppConfig) => void;
  onError: (message: string, title?: string) => void;
  onSuccess: (message: string, title?: string) => void;
  disabled?: boolean;
};

export function WizardUploadServerStep({
  draft,
  setDraft,
  onError,
  onSuccess,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const checkConnection = useServerStore((s) => s.checkConnection);
  const serverPhase = useServerStore((s) => s.phase);
  const serverMessage = useServerStore((s) => s.message);

  const [mode, setMode] = useState<Mode>("ams");
  const [discovering, setDiscovering] = useState(false);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<AmsBridgeDiscovered[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [token, setToken] = useState(draft.ams_bridge_token);
  const [profileLabel, setProfileLabel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [testingServer, setTestingServer] = useState(false);
  const [pathsApplied, setPathsApplied] = useState(false);
  const [amsStatus, setAmsStatus] = useState("");

  const autoDiscoverStarted = useRef(false);
  const title = t("app.server.title");

  const selected =
    candidates.find(
      (c) => `${c.base_url}\0${c.instance_id || c.instance}` === selectedKey,
    ) ?? null;

  useEffect(() => {
    if (disabled || mode !== "ams" || autoDiscoverStarted.current) return;
    autoDiscoverStarted.current = true;
    void runDiscover();
  }, [disabled, mode]);

  useEffect(() => {
    if (!selected) return;
    const label = discoveredAmsLabel(selected);
    setProfileLabel((prev) => (prev.trim() ? prev : label));
  }, [selected]);

  async function runDiscover() {
    if (discovering || disabled) return;
    setDiscovering(true);
    setAmsStatus("");
    setPathsApplied(false);
    try {
      const list = await amsBridgeDiscover(3);
      setCandidates(list);
      setSearched(true);
      if (list.length === 1) {
        const only = list[0]!;
        setSelectedKey(`${only.base_url}\0${only.instance_id || only.instance}`);
      } else if (list.length === 0) {
        setSelectedKey("");
      } else {
        const savedId = draft.ams_bridge_server_instance_id.trim();
        const preferred =
          (savedId &&
            list.find((c) => c.instance_id.trim() === savedId)) ||
          list[0]!;
        setSelectedKey(
          `${preferred.base_url}\0${preferred.instance_id || preferred.instance}`,
        );
      }
    } catch (err) {
      setCandidates([]);
      setSearched(true);
      onError(String(err), title);
    } finally {
      setDiscovering(false);
    }
  }

  async function onConnectAndApply() {
    if (!selected || connecting || disabled) return;
    const tokenTrim = token.trim();
    if (!tokenTrim) {
      onError(t("setupWizard.upload.tokenRequired"), title);
      return;
    }
    setConnecting(true);
    setAmsStatus("");
    try {
      const result = await amsBridgeHealth({
        baseUrl: selected.base_url,
        token: tokenTrim,
      });
      if (!result.ok) {
        setAmsStatus(result.message);
        onError(result.message, title);
        return;
      }
      useAmsBridgeStore.getState().applyResult(result);

      const displayName =
        result.health?.display_name?.trim() ||
        selected.display_name.trim() ||
        discoveredAmsLabel(selected);
      const instanceId =
        result.health?.instance_id?.trim() ||
        selected.instance_id.trim() ||
        "";

      let next: AppConfig = {
        ...draft,
        ams_bridge_url: result.base_url || selected.base_url,
        ams_bridge_token: tokenTrim,
        ams_bridge_last_ok_url: result.base_url || selected.base_url,
        ams_bridge_display_name: displayName,
        ams_bridge_server_instance_id: instanceId,
      };

      const label = profileLabel.trim() || displayName;
      if (label) {
        next = patchActiveServerProfileLabel(next, label);
      }

      const hints = parsePathHintsFromHealth(result.health);
      if (hints?.primarySmbUrl) {
        next = await applyAmsPathHintsWithCredentials({
          config: next,
          hints,
          interactive: true,
        });
        next = bindPathHintsServerInstance(next, instanceId);
        if (label) {
          next = patchActiveServerProfileLabel(next, label);
        }
        setPathsApplied(true);
        setAmsStatus(
          t("setupWizard.upload.pathsApplied", {
            primary: hints.primarySmbUrl,
          }),
        );
      } else {
        setPathsApplied(false);
        setAmsStatus(t("setupWizard.upload.connectedNoPaths"));
        setMode("manual");
      }

      setDraft(next);
      useAmsBridgeStore.getState().refreshPathHintsDiff(next);

      if (next.server_url.trim() && !isPlaceholderServerUrl(next.server_url)) {
        void checkConnection({
          server_url: next.server_url,
          server_login: next.server_login,
          server_password: next.server_password,
        });
      }
    } catch (err) {
      onError(String(err), title);
    } finally {
      setConnecting(false);
    }
  }

  function choosePreset(profileId: string) {
    const next = switchServerProfile(draft, profileId);
    setDraft(next);
    setMode("manual");
    setPathsApplied(false);
  }

  async function onTestServer() {
    if (testingServer || disabled) return;
    setTestingServer(true);
    try {
      const result = await checkConnection({
        server_url: draft.server_url,
        server_login: draft.server_login,
        server_password: draft.server_password,
      });
      if (result.ok) onSuccess(result.message, title);
      else {
        const presented = presentServerConnectionError({
          rawMessage: result.message,
          serverUrl: draft.server_url,
          login: draft.server_login,
          password: draft.server_password,
          omitSettingsAction: true,
        });
        onError(presented.message, title);
      }
    } finally {
      setTestingServer(false);
    }
  }

  const locked = disabled || discovering || connecting;

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-border bg-background/60 p-3",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("setupWizard.sections.server")}
        </p>
        {mode === "manual" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={locked}
            onClick={() => {
              setMode("ams");
              void runDiscover();
            }}
          >
            <Search className="size-3.5" aria-hidden />
            {t("setupWizard.upload.searchAgain")}
          </Button>
        ) : null}
      </div>

      <p className="text-xs leading-snug text-muted">
        {t("setupWizard.upload.amsHint")}
      </p>

      {mode === "ams" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={locked}
              onClick={() => void runDiscover()}
            >
              {discovering ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("setupWizard.upload.searching")}
                </>
              ) : (
                <>
                  <Search className="size-3.5" aria-hidden />
                  {t("setupWizard.upload.searchNetwork")}
                </>
              )}
            </Button>
            {discovering ? (
              <span className="text-xs text-muted">
                {t("setupWizard.upload.searchingHint")}
              </span>
            ) : null}
          </div>

          {searched && !discovering && candidates.length === 0 ? (
            <div className="space-y-2 rounded-md border border-dashed border-border/80 bg-background/40 p-3">
              <p className="text-sm text-muted">
                {t("setupWizard.upload.noneFound")}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={locked}
                onClick={() => setMode("manual")}
              >
                {t("setupWizard.upload.setupManually")}
              </Button>
            </div>
          ) : null}

          {candidates.length > 0 ? (
            <ul className="space-y-1.5">
              {candidates.map((c) => {
                const key = `${c.base_url}\0${c.instance_id || c.instance}`;
                const active = key === selectedKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setSelectedKey(key)}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left transition-colors",
                        active
                          ? "border-sky-400/50 bg-sky-500/10"
                          : "border-border/70 bg-background/50 hover:border-border",
                      )}
                    >
                      <p className="text-sm font-medium text-foreground">
                        {discoveredAmsLabel(c)}
                      </p>
                      <p className="text-[11px] text-muted">
                        {c.base_url}
                        {c.version ? ` · v${c.version}` : ""}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {selected ? (
            <div className="space-y-2.5">
              <div className="space-y-1.5">
                <Label>{t("settings.server.ams.token")}</Label>
                <PasswordInput
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  disabled={locked}
                  placeholder={t("setupWizard.upload.tokenPlaceholder")}
                />
                <p className="text-[11px] text-muted">
                  {t("setupWizard.upload.tokenHint")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t("setupWizard.upload.profileName")}</Label>
                <Input
                  value={profileLabel}
                  onChange={(e) => setProfileLabel(e.target.value)}
                  disabled={locked}
                  placeholder={discoveredAmsLabel(selected)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={locked || !token.trim()}
                  onClick={() => void onConnectAndApply()}
                >
                  {connecting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      {t("common.actions.checking")}
                    </>
                  ) : (
                    t("setupWizard.upload.connectAndApply")
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => setMode("manual")}
                >
                  {t("setupWizard.upload.skipAms")}
                </Button>
              </div>
              {amsStatus ? (
                <p
                  className={cn(
                    "text-xs",
                    pathsApplied ? "text-emerald-800 dark:text-emerald-200" : "text-muted",
                  )}
                >
                  {amsStatus}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {t("setupWizard.upload.manualHint")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={locked}
              onClick={() => choosePreset(DEFAULT_SERVER_PROFILE_ID)}
              className={cn(
                "rounded-md border px-3 py-2.5 text-left transition-colors",
                draft.active_server_profile_id === DEFAULT_SERVER_PROFILE_ID
                  ? "border-sky-400/50 bg-sky-500/10"
                  : "border-border/70 bg-background/50 hover:border-border",
              )}
            >
              <p className="text-sm font-medium">
                {PRESET_SERVER_PROFILE_LABELS.calden}
              </p>
              <p className="text-[11px] text-muted">
                {t("setupWizard.upload.presetCaldenHint")}
              </p>
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => choosePreset(GERA_SERVER_PROFILE_ID)}
              className={cn(
                "rounded-md border px-3 py-2.5 text-left transition-colors",
                draft.active_server_profile_id === GERA_SERVER_PROFILE_ID
                  ? "border-sky-400/50 bg-sky-500/10"
                  : "border-border/70 bg-background/50 hover:border-border",
              )}
            >
              <p className="text-sm font-medium">
                {PRESET_SERVER_PROFILE_LABELS.gera}
              </p>
              <p className="text-[11px] text-muted">
                {t("setupWizard.upload.presetGeraHint")}
              </p>
            </button>
          </div>

          <div className="space-y-1.5">
            <Label>{t("settings.server.smb.url")}</Label>
            <Input
              value={draft.server_url}
              onChange={(e) =>
                setDraft(patchServerConnection(draft, { url: e.target.value }))
              }
              disabled={locked}
              placeholder="smb://…"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("settings.server.smb.login")}</Label>
              <Input
                value={draft.server_login}
                onChange={(e) =>
                  setDraft(
                    patchServerConnection(draft, { login: e.target.value }),
                  )
                }
                disabled={locked}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.server.smb.password")}</Label>
              <PasswordInput
                value={draft.server_password}
                onChange={(e) =>
                  setDraft(
                    patchServerConnection(draft, { password: e.target.value }),
                  )
                }
                disabled={locked}
                autoComplete="current-password"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={locked || testingServer}
              onClick={() => void onTestServer()}
            >
              {testingServer
                ? t("common.actions.checking")
                : t("common.actions.testConnection")}
            </Button>
            {!testingServer &&
            serverPhase !== "checking" &&
            serverPhase !== "idle" ? (
              <span className="text-xs text-muted">
                {serverConnectionStatusLabel(serverPhase, serverMessage)}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
