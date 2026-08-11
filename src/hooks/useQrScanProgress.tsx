import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  normalizeMediaPath,
  useQrScanStore,
  type QrScanPhase,
} from "../store/qrScanStore";

export type QrScanProgressPayload = {
  path: string;
  phase: string;
};

export type QrFollowupProgressPayload = {
  path: string;
  phase: string;
  scanned: number;
  extra_hits: number;
};

/** Keep grid QR progress in sync with Rust `qr-scan-progress` events. */
export function useQrScanProgressListener() {
  const setPhase = useQrScanStore((s) => s.setPhase);
  const setFollowup = useQrScanStore((s) => s.setFollowup);

  useEffect(() => {
    let unlistenScan: (() => void) | undefined;
    let unlistenFollowup: (() => void) | undefined;

    void listen<QrScanProgressPayload>("qr-scan-progress", (event) => {
      const { path, phase } = event.payload;
      if (!path) return;
      if (phase === "start") setPhase(path, "active");
      else if (phase === "hit") setPhase(path, "hit");
      else if (phase === "done") setPhase(path, "done");
    }).then((fn) => {
      unlistenScan = fn;
    });

    void listen<QrFollowupProgressPayload>("qr-followup-progress", (event) => {
      const { path, phase, scanned, extra_hits } = event.payload;
      const p =
        phase === "hit" || phase === "miss" || phase === "start"
          ? phase
          : null;
      setFollowup({
        currentPath: path || null,
        phase: p,
        scanned: Number(scanned) || 0,
        extraHits: Number(extra_hits) || 0,
      });
      if (path && phase === "start") {
        setPhase(path, "active");
      } else if (path && phase === "hit") {
        setPhase(path, "hit");
      } else if (path && phase === "miss") {
        setPhase(path, "done");
      }
    }).then((fn) => {
      unlistenFollowup = fn;
    });

    return () => {
      unlistenScan?.();
      unlistenFollowup?.();
    };
  }, [setPhase, setFollowup]);
}

export function QrScanRowBar({ path }: { path: string }) {
  const phase = useQrScanStore((s) => s.byPath[normalizeMediaPath(path)] ?? null);
  if (!phase) return null;
  return <QrScanBar phase={phase} />;
}

export function QrScanBar({ phase }: { phase: QrScanPhase }) {
  const label =
    phase === "active"
      ? "QR-Scan läuft…"
      : phase === "pending"
        ? "QR-Scan wartet…"
        : phase === "hit"
          ? "QR gefunden"
          : "QR geprüft";

  return (
    <div
      className={
        phase === "active"
          ? "ats-qr-scan-bar mt-1"
          : phase === "pending"
            ? "ats-qr-scan-bar ats-qr-scan-bar-pending mt-1"
            : phase === "hit"
              ? "ats-qr-scan-bar ats-qr-scan-bar-hit mt-1"
              : "ats-qr-scan-bar ats-qr-scan-bar-done mt-1"
      }
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={label}
      title={label}
    />
  );
}
