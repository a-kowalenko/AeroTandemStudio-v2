import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getRecentLogs, type LogEntry } from "../lib/tauri";
import { useLogStore } from "../store/logStore";

/**
 * Loads buffered logs and keeps the console store in sync via `log-line` events.
 */
export function useLogListener() {
  const replaceEntries = useLogStore((s) => s.replaceEntries);
  const appendEntry = useLogStore((s) => s.appendEntry);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await getRecentLogs();
        if (!cancelled) replaceEntries(entries);
      } catch {
        // Browser preview / backend not ready
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replaceEntries]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<LogEntry>("log-line", (event) => {
      appendEntry(event.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // ignore
      });
    return () => {
      unlisten?.();
    };
  }, [appendEntry]);
}
