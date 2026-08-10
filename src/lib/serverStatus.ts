import type { ServerPhase } from "@/store/serverStore";

/** Compact label next to „Verbindung testen“ / status chip. */
export function serverConnectionStatusLabel(
  phase: ServerPhase,
  message = "",
): string {
  switch (phase) {
    case "connected":
      return "✓ Verbunden";
    case "checking":
      return "Prüfe…";
    case "uploading":
      return "Upload…";
    case "idle":
      return "Nicht geprüft";
    case "error":
      return mapServerErrorLabel(message);
    default:
      return "Nicht geprüft";
  }
}

/**
 * Compact status line: reachability → „Nicht verbunden“;
 * concrete faults stay specific (login, share, URL, …).
 */
export function mapServerErrorLabel(message: string): string {
  const detail = mapServerErrorDetail(message);
  if (detail.kind === "unreachable") return "Nicht verbunden";
  return detail.text;
}

/** Short text for dialogs/toasts after an explicit connection test. */
export function mapServerErrorDetail(message: string): {
  kind: "unreachable" | "error";
  text: string;
} {
  const raw = message.trim();
  if (!raw) {
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  const lower = raw.toLowerCase();

  if (
    /ungültige\s+server-url|invalid\s+server|url\s+fehlt|keine\s+server/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Ungültige Server-URL" };
  }
  if (/lokaler\s+pfad\s+nicht\s+gefunden|path\s+not\s+found/.test(lower)) {
    return { kind: "error", text: "Pfad nicht gefunden" };
  }
  if (
    /ungültiger\s+benutzername|passwort|logon|access_denied.*session|login\s+fehl/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Login fehlgeschlagen" };
  }
  if (/kein\s+zugriff\s+auf\s+freigabe/.test(lower)) {
    return { kind: "error", text: "Kein Zugriff auf Freigabe" };
  }
  if (/listing\s+fehlgeschlagen/.test(lower)) {
    return {
      kind: "error",
      text: "Share erreichbar, Listing fehlgeschlagen",
    };
  }
  if (
    /bad_network_name|object_name_not_found|share\s+nicht|server\s+oder\s+freigabe|freigabe\s+'/.test(
      lower,
    )
  ) {
    return { kind: "error", text: "Server/Freigabe nicht gefunden" };
  }

  if (
    /nicht\s+erreichbar|timed?\s*out|timeout|connection\s+refused|actively\s+refused|no\s+route|network\s+is\s+unreachable|host\s+unreachable|failed\s+to\s+lookup|name\s+or\s+service|no\s+such\s+host|dns\s+error|os\s+error\s+10060|os\s+error\s+10061|os\s+error\s+110|os\s+error\s+111|smb-verbindung\s+fehlgeschlagen/.test(
      lower,
    )
  ) {
    if (/server nicht erreichbar/i.test(raw)) {
      const short = raw.replace(/\.$/, "");
      return {
        kind: "unreachable",
        text: short.length > 60 ? "Nicht verbunden" : short,
      };
    }
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  let short = raw
    .replace(/^SMB-Verbindung fehlgeschlagen:\s*/i, "")
    .replace(/^Verbindung fehlgeschlagen:\s*/i, "")
    .trim();

  if (
    /error\s+sending|reqwest|dns\s+error|os\s+error|errno|0x[0-9a-f]+/i.test(
      short,
    )
  ) {
    return { kind: "unreachable", text: "Nicht verbunden" };
  }

  if (short.length > 52) {
    short = `${short.slice(0, 49)}…`;
  }
  return { kind: "error", text: short || "Nicht verbunden" };
}
