import { useEffect, useRef, useState, type RefObject } from "react";
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
  presentServerConnectionError,
  SERVER_GUEST_HINT,
  serverConnectionStatusLabel,
} from "@/lib/serverStatus";
import {
  AMS_OPERATOR_TITLE,
  formatAmsHealthSuccessMessage,
  presentAmsBridgeError,
} from "@/lib/amsBridgeStatus";
import { amsBridgeDiscover } from "@/lib/tauri";
import type { AmsBridgeDiscovered } from "@/lib/tauri";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type Props = SettingsTabBaseProps & {
  flashFocus: SettingsFocusTarget | null;
};

export function ServerTab({ draft, patch, setDraft, flashFocus }: Props) {
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
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

  async function onTestServer() {
    if (testingServer) return;
    setTestingServer(true);
    try {
      const result = await checkConnection({
        server_url: draft.server_url,
        server_login: draft.server_login,
        server_password: draft.server_password,
      });
      if (result.ok) showSuccess(result.message, "Server");
      else {
        const presented = presentServerConnectionError({
          rawMessage: result.message,
          serverUrl: draft.server_url,
          login: draft.server_login,
          password: draft.server_password,
          omitSettingsAction: true,
        });
        showError(presented.message, "Server");
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
        showError("Einstellungen konnten nicht gespeichert werden.", AMS_OPERATOR_TITLE);
        return;
      }
      setDraft(saved);
      const result = await checkAmsHealth();
      if (result.ok) {
        const okMsg = formatAmsHealthSuccessMessage(result.message);
        setBridgeLabel(okMsg);
        showSuccess(okMsg, AMS_OPERATOR_TITLE);
        if (result.base_url) {
          patch("ams_bridge_last_ok_url", result.base_url);
        }
      } else {
        const presented = presentAmsBridgeError({
          rawMessage: result.message,
          omitSettingsAction: true,
        });
        setBridgeLabel(presented.message);
        showError(presented.message, AMS_OPERATOR_TITLE);
      }
    } catch (err) {
      const presented = presentAmsBridgeError({
        rawMessage: String(err),
        omitSettingsAction: true,
      });
      setBridgeLabel(presented.message);
      showError(presented.message, AMS_OPERATOR_TITLE);
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
        setBridgeLabel("Keine Buchungssuche im Netzwerk gefunden.");
        showError(
          "Nichts gefunden. Adresse ggf. manuell eintragen.",
          AMS_OPERATOR_TITLE,
        );
      } else if (list.length === 1) {
        patch("ams_bridge_url", list[0].base_url);
        setBridgeLabel(`Gefunden: ${list[0].instance} → ${list[0].base_url}`);
        showSuccess(
          `Adresse übernommen: ${list[0].base_url}. Zugangscode weiter manuell eintragen.`,
          AMS_OPERATOR_TITLE,
        );
      } else {
        setBridgeLabel(`${list.length} Adressen gefunden — bitte auswählen.`);
      }
    } catch (err) {
      const presented = presentAmsBridgeError({
        rawMessage: String(err),
        omitSettingsAction: true,
      });
      setBridgeLabel(presented.message);
      showError(presented.message, AMS_OPERATOR_TITLE);
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title="SMB-Server"
        description="Zugangsdaten für Upload nach Erstellung eines Vorgangs."
      >
        <div ref={serverUrlRef} className="relative space-y-1.5 rounded-xl p-2.5">
          {flashFocus === "server-url" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label className="relative">Server-URL</Label>
          <Input
            ref={serverUrlInputRef}
            className="relative"
            value={draft.server_url}
            onChange={(e) => patch("server_url", e.target.value)}
            placeholder="smb://…"
          />
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
              <Label>Login</Label>
              <Input
                ref={serverLoginInputRef}
                value={draft.server_login}
                onChange={(e) => patch("server_login", e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Passwort</Label>
              <PasswordInput
                value={draft.server_password}
                onChange={(e) => patch("server_password", e.target.value)}
                autoComplete="current-password"
              />
            </div>
          </div>
          <p className="relative text-[11px] text-muted">{SERVER_GUEST_HINT}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testingServer}
            onClick={() => void onTestServer()}
          >
            {testingServer ? "Prüfe…" : "Verbindung testen"}
          </Button>
          {!testingServer && serverPhase !== "checking" ? (
            <button
              type="button"
              className="cursor-pointer rounded text-xs text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={
                serverPhase === "error" && serverMessage
                  ? `${serverMessage}\nKlicken zum erneuten Prüfen`
                  : "Klicken zum erneuten Prüfen"
              }
              onClick={() => void onTestServer()}
            >
              {serverConnectionStatusLabel(serverPhase, serverMessage)}
            </button>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Upload">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.upload_to_server}
            onCheckedChange={(v) => patch("upload_to_server", v === true)}
          />
          Nach Erstellung auf Server hochladen
        </label>
      </SettingsSection>

      <SettingsSection
        title="Buchungssuche (optional)"
        description="Füllt Name und Medien, wenn Kunden-ID und Buchungs-ID passen. Ohne Verbindung geht alles weiter per Hand. Dateien werden trotzdem übergeben."
      >
        <div ref={amsUrlRef} className="relative space-y-1.5 rounded-xl p-2.5">
          {flashFocus === "ams-bridge-url" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label className="relative">Adresse</Label>
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
          <Label className="relative">Zugangscode</Label>
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
            Zuletzt erfolgreich: {draft.ams_bridge_last_ok_url}
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
            {discovering ? "Suche…" : "Im Netzwerk suchen"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testingBridge}
            onClick={() => void onTestBridge()}
          >
            {testingBridge ? "Prüfe…" : "Verbindung prüfen"}
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
                    patch("ams_bridge_url", d.base_url);
                    setBridgeLabel(`Übernommen: ${d.instance} → ${d.base_url}`);
                    setDiscovered([]);
                  }}
                >
                  {d.instance} — {d.base_url}
                  {d.version ? ` (v${d.version})` : ""}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsSection>
    </div>
  );
}
