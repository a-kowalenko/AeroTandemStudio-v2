import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useServerStore } from "@/store/serverStore";
import { useUiStore } from "@/store/uiStore";
import type { SettingsFocusTarget } from "@/store/uiStore";
import {
  presentServerConnectionError,
  SERVER_GUEST_HINT,
  serverConnectionStatusLabel,
} from "@/lib/serverStatus";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type Props = SettingsTabBaseProps & {
  flashFocus: SettingsFocusTarget | null;
};

export function ServerTab({ draft, patch, flashFocus }: Props) {
  const showSuccess = useUiStore((s) => s.showSuccess);
  const showError = useUiStore((s) => s.showError);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const serverPhase = useServerStore((s) => s.phase);
  const serverMessage = useServerStore((s) => s.message);
  const [testingServer, setTestingServer] = useState(false);
  const serverUrlRef = useRef<HTMLDivElement | null>(null);
  const serverCredentialsRef = useRef<HTMLDivElement | null>(null);
  const serverUrlInputRef = useRef<HTMLInputElement | null>(null);
  const serverLoginInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!flashFocus) return;
    const container =
      flashFocus === "server-url"
        ? serverUrlRef.current
        : serverCredentialsRef.current;
    const input =
      flashFocus === "server-url"
        ? serverUrlInputRef.current
        : serverLoginInputRef.current;
    container?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      input?.focus({ preventScroll: true });
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
    </div>
  );
}
