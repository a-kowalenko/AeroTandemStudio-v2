import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useServerStore } from "@/store/serverStore";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useUiStore } from "@/store/uiStore";
import type { SettingsFocusTarget } from "@/store/uiStore";
import {
  serverGuestHint,
  serverConnectionStatusLabel,
} from "@/lib/serverStatus";
import { presentAmsBridgeError } from "@/lib/amsBridgeStatus";
import {
  presentAmsConnectionAction,
  presentServerConnectionAction,
} from "@/lib/headerConnectionStatus";
import { amsBridgeDiscover, amsBridgeHealth } from "@/lib/tauri";
import type { AmsBridgeDiscovered } from "@/lib/tauri";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type Props = SettingsTabBaseProps & {
  flashFocus: SettingsFocusTarget | null;
};

export function ServerTab({ draft, patch, setDraft, flashFocus }: Props) {
  const { t } = useTranslation();
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);
  const persistConfig = useConfigStore((s) => s.persist);
  const serverPhase = useServerStore((s) => s.phase);
  const serverMessage = useServerStore((s) => s.message);
  const [testingServer, setTestingServer] = useState(false);
  const [testingBridge, setTestingBridge] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<AmsBridgeDiscovered[]>([]);
  const [bridgeLabel, setBridgeLabel] = useState("—");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const serverUrlRef = useRef<HTMLDivElement | null>(null);
  const serverCredentialsRef = useRef<HTMLDivElement | null>(null);
  const serverUrlInputRef = useRef<HTMLInputElement | null>(null);
  const serverLoginInputRef = useRef<HTMLInputElement | null>(null);
  const amsUrlRef = useRef<HTMLDivElement | null>(null);
  const amsTokenRef = useRef<HTMLDivElement | null>(null);
  const amsUrlInputRef = useRef<HTMLInputElement | null>(null);
  const amsTokenInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!flashFocus) return;
    const targets: Record<
      SettingsFocusTarget,
      {
        container: RefObject<HTMLDivElement | null>;
        input: RefObject<HTMLInputElement | null>;
      }
    > = {
      "server-url": { container: serverUrlRef, input: serverUrlInputRef },
      "server-credentials": {
        container: serverCredentialsRef,
        input: serverLoginInputRef,
      },
      "ams-bridge-url": { container: amsUrlRef, input: amsUrlInputRef },
      "ams-bridge-token": { container: amsTokenRef, input: amsTokenInputRef },
    };
    const target = targets[flashFocus];
    target.container.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      target.input.current?.focus({ preventScroll: true });
    }, 120);
  }, [flashFocus]);

  function serverUrlToDialogDefaultPath(serverUrl: string) {
    const raw = serverUrl.trim();
    if (!raw) return undefined;
    if (raw.toLowerCase().startsWith("smb://")) {
      let rest = raw.slice(6); // strip smb://
      if (rest.includes("@")) {
        // smb://user@host/share → \\host\share
        rest = rest.split("@").slice(1).join("@");
      }
      rest = rest.replace(/\//g, "\\");
      return `\\\\${rest.replace(/^\\+/, "")}`;
    }
    if (raw.startsWith("//")) return `\\${raw}`;
    return raw;
  }

  async function pickServerPath() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: serverUrlToDialogDefaultPath(draft?.server_url ?? ""),
      });
      if (typeof selected === "string") {
        const next = selected.trim();
        if (!next) return;
        patch("server_url", next);
      }
    } catch (err) {
      showError(String(err), t("settings.tabs.server"));
    }
  }

  async function onTestServer() {
    if (testingServer) return;
    setTestingServer(true);
    try {
      const result = await checkConnection({
        server_url: draft.server_url,
        server_login: draft.server_login,
        server_password: draft.server_password,
      });
      const action = presentServerConnectionAction({
        ok: result.ok,
        rawMessage: result.message,
        serverUrl: draft.server_url,
        login: draft.server_login,
        password: draft.server_password,
      });
      if (result.ok) {
        showSuccess("", t("header.connection.titleServerOk"), {
          actions: [action],
          autoCloseSecs: 3,
        });
      } else {
        showSuccess("", t("header.connection.titleFailed"), {
          actions: [action],
        });
      }
    } finally {
      setTestingServer(false);
    }
  }

  async function onTestBridge() {
    if (testingBridge) return;
    setTestingBridge(true);
    try {
      // Persist draft bridge fields so the Rust command reads current values.
      const saved = await persistConfig({
        ...draft,
        ams_bridge_url: draft.ams_bridge_url,
        ams_bridge_token: draft.ams_bridge_token,
      });
      if (!saved) {
        showError(t("settings.server.ams.saveFailed"), t("settings.server.ams.operatorTitle"));
        return;
      }
      setDraft(saved);
      const result = await checkAmsHealth();
      const action = presentAmsConnectionAction({
        ok: result.ok,
        rawMessage: result.message,
      });
      if (result.ok) {
        setBridgeLabel(action.summary);
        showSuccess("", t("header.connection.titleAmsOk"), {
          actions: [action],
          autoCloseSecs: 3,
        });
        if (result.base_url) {
          patch("ams_bridge_last_ok_url", result.base_url);
        }
      } else {
        const presented = presentAmsBridgeError({
          rawMessage: result.message,
          omitSettingsAction: true,
        });
        setBridgeLabel(presented.message);
        showSuccess("", t("header.connection.titleFailed"), {
          actions: [action],
        });
      }
    } catch (err) {
      const presented = presentAmsBridgeError({
        rawMessage: String(err),
        omitSettingsAction: true,
      });
      setBridgeLabel(presented.message);
      showSuccess("", t("header.connection.titleFailed"), {
        actions: [
          presentAmsConnectionAction({
            ok: false,
            rawMessage: String(err),
          }),
        ],
      });
    } finally {
      setTestingBridge(false);
    }
  }

  async function onDiscoverBridge() {
    if (discovering) return;
    setDiscovering(true);
    setDiscovered([]);
    try {
      const list = await amsBridgeDiscover(3);
      setDiscovered(list);
      if (list.length === 0) {
        setBridgeLabel(t("settings.server.ams.noneFoundStatus"));
        showError(
          t("settings.server.ams.noneFoundError"),
          t("settings.server.ams.operatorTitle"),
        );
      } else if (list.length === 1) {
        await applyDiscoveredAmsUrl(list[0].base_url, list[0].instance);
      } else {
        setBridgeLabel(t("settings.server.ams.foundMany", { count: list.length }));
      }
    } catch (err) {
      const presented = presentAmsBridgeError({
        rawMessage: String(err),
        omitSettingsAction: true,
      });
      setBridgeLabel(presented.message);
      showError(presented.message, t("settings.server.ams.operatorTitle"));
    } finally {
      setDiscovering(false);
    }
  }

  /** Try server password as AMS token; on failure open token prompt. */
  async function applyDiscoveredAmsUrl(baseUrl: string, instance?: string) {
    patch("ams_bridge_url", baseUrl);
    setBridgeLabel(
      t("settings.server.ams.foundStatus", {
        instance: instance ?? "",
        url: baseUrl,
      }),
    );

    const current = draftRef.current;
    const serverPassword = current?.server_password?.trim() ?? "";
    if (serverPassword && current) {
      try {
        const result = await amsBridgeHealth({
          baseUrl,
          token: serverPassword,
        });
        if (result.ok) {
          useAmsBridgeStore.getState().applyResult(result);
          const next = {
            ...current,
            ams_bridge_url: baseUrl,
            ams_bridge_token: serverPassword,
            ams_bridge_last_ok_url: result.base_url || baseUrl,
          };
          patch("ams_bridge_token", serverPassword);
          if (result.base_url) {
            patch("ams_bridge_last_ok_url", result.base_url);
          }
          const saved = await persistConfig(next);
          if (saved) setDraft(saved);
          const action = presentAmsConnectionAction({
            ok: true,
            rawMessage: result.message,
          });
          setBridgeLabel(action.summary);
          showSuccess(
            t("settings.server.ams.foundSuccessViaServerPassword"),
            t("header.connection.titleAmsOk"),
            {
              actions: [action],
              autoCloseSecs: 3,
            },
          );
          return;
        }
      } catch {
        // Fall through to manual token prompt.
      }
    }

    promptAmsTokenAfterDiscover(baseUrl);
  }

  function promptAmsTokenAfterDiscover(baseUrl: string) {
    const current = draftRef.current;
    showSuccess(
      t("settings.server.ams.foundSuccess", { url: baseUrl }),
      t("settings.server.ams.operatorTitle"),
      {
        prompt: {
          label: t("settings.server.ams.token"),
          password: true,
          initialValue: current?.ams_bridge_token ?? "",
          submitLabel: t("ams.actions.checkToken"),
          cancelLabel: t("dialogs.update.later"),
          onCancel: () => closeDialog(),
          onSubmit: async (token) => {
            const latest = draftRef.current;
            if (!latest) return;
            const next = {
              ...latest,
              ams_bridge_url: baseUrl,
              ams_bridge_token: token,
            };
            patch("ams_bridge_url", baseUrl);
            patch("ams_bridge_token", token);
            const saved = await persistConfig(next);
            if (!saved) {
              showError(
                t("settings.server.ams.saveFailed"),
                t("settings.server.ams.operatorTitle"),
              );
              return;
            }
            setDraft(saved);
            const result = await checkAmsHealth();
            const action = presentAmsConnectionAction({
              ok: result.ok,
              rawMessage: result.message,
            });
            if (result.ok) {
              setBridgeLabel(action.summary);
              if (result.base_url) {
                patch("ams_bridge_last_ok_url", result.base_url);
              }
              showSuccess("", t("header.connection.titleAmsOk"), {
                actions: [action],
                autoCloseSecs: 3,
              });
            } else {
              const presented = presentAmsBridgeError({
                rawMessage: result.message,
                omitSettingsAction: true,
              });
              setBridgeLabel(presented.message);
              showSuccess("", t("header.connection.titleFailed"), {
                actions: [action],
              });
            }
          },
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.server.smb.title")}
        description={t("settings.server.smb.description")}
      >
        <div ref={serverUrlRef} className="relative space-y-1.5 rounded-xl p-2.5">
          {flashFocus === "server-url" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label className="relative">{t("settings.server.smb.url")}</Label>
          <div className="relative">
            <Input
              ref={serverUrlInputRef}
              className="relative pr-10"
              value={draft.server_url}
              onChange={(e) => patch("server_url", e.target.value)}
              placeholder={t("settings.server.smb.urlPlaceholder")}
            />
            <button
              type="button"
              disabled={false}
              onClick={() => void pickServerPath()}
              title={t("common.actions.pickFolder")}
              aria-label={t("common.actions.pickFolder")}
              className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>

        <div
          ref={serverCredentialsRef}
          className="relative space-y-1.5 rounded-xl p-2.5"
        >
          {flashFocus === "server-credentials" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <div className="relative grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("settings.server.smb.login")}</Label>
              <Input
                ref={serverLoginInputRef}
                value={draft.server_login}
                onChange={(e) => patch("server_login", e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.server.smb.password")}</Label>
              <PasswordInput
                value={draft.server_password}
                onChange={(e) => patch("server_password", e.target.value)}
                autoComplete="current-password"
              />
            </div>
          </div>
          <p className="relative text-[11px] text-muted">{serverGuestHint()}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testingServer}
            onClick={() => void onTestServer()}
          >
            {testingServer ? t("common.actions.checking") : t("common.actions.testConnection")}
          </Button>
          {!testingServer && serverPhase !== "checking" ? (
            <button
              type="button"
              className="cursor-pointer rounded text-xs text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={
                serverPhase === "error" && serverMessage
                  ? t("settings.server.smb.recheckTitleWithMessage", {
                      message: serverMessage,
                    })
                  : t("settings.server.smb.recheckTitle")
              }
              onClick={() => void onTestServer()}
            >
              {serverConnectionStatusLabel(serverPhase, serverMessage)}
            </button>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.server.upload.title")}>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.upload_to_server}
            onCheckedChange={(v) => patch("upload_to_server", v === true)}
          />
          {t("settings.server.upload.afterCreate")}
        </label>
      </SettingsSection>

      <SettingsSection
        title={t("settings.server.ams.title")}
        description={t("settings.server.ams.description")}
      >
        <div ref={amsUrlRef} className="relative space-y-1.5 rounded-xl p-2.5">
          {flashFocus === "ams-bridge-url" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label className="relative">{t("settings.server.ams.address")}</Label>
          <Input
            ref={amsUrlInputRef}
            className="relative"
            value={draft.ams_bridge_url}
            onChange={(e) => patch("ams_bridge_url", e.target.value)}
            placeholder="http://169.254.x.x:8787"
          />
        </div>
        <div ref={amsTokenRef} className="relative space-y-1.5 rounded-xl p-2.5">
          {flashFocus === "ams-bridge-token" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label className="relative">{t("settings.server.ams.token")}</Label>
          <PasswordInput
            ref={amsTokenInputRef}
            className="relative"
            value={draft.ams_bridge_token}
            onChange={(e) => patch("ams_bridge_token", e.target.value)}
            autoComplete="off"
          />
        </div>
        {draft.ams_bridge_last_ok_url.trim() ? (
          <p className="text-[11px] text-muted">
            {t("settings.server.ams.lastOk", {
              url: draft.ams_bridge_last_ok_url,
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={discovering}
            onClick={() => void onDiscoverBridge()}
          >
            {discovering
              ? t("settings.server.ams.searching")
              : t("settings.server.ams.searchNetwork")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testingBridge}
            onClick={() => void onTestBridge()}
          >
            {testingBridge
              ? t("common.actions.checking")
              : t("settings.server.ams.checkConnection")}
          </Button>
          <span className="text-xs text-muted">{bridgeLabel}</span>
        </div>
        {discovered.length > 1 ? (
          <ul className="space-y-1 rounded-md border border-border/60 p-2 text-xs">
            {discovered.map((d) => (
              <li key={d.base_url + d.instance}>
                <button
                  type="button"
                  className="w-full text-left hover:underline"
                  onClick={() => {
                    void applyDiscoveredAmsUrl(d.base_url, d.instance);
                    setDiscovered([]);
                  }}
                >
                  {t("settings.server.ams.discoveredItem", {
                    instance: d.instance,
                    url: d.base_url,
                    version: d.version ? ` (v${d.version})` : "",
                  })}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsSection>
    </div>
  );
}
