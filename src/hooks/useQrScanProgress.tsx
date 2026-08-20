import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { QrCode } from "lucide-react";
import { tr } from "@/i18n";
import {
  normalizeMediaPath,
  useQrScanStore,
  type QrScanPhase,
} from "../store/qrScanStore";

export type QrScanProgressPayload = {
  path: string;
  phase: string;
  frame?: number;
  frames_total?: number;
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
  const setClipProgress = useQrScanStore((s) => s.setClipProgress);
  const setFollowup = useQrScanStore((s) => s.setFollowup);

  useEffect(() => {
    let unlistenScan: (() => void) | undefined;
    let unlistenFollowup: (() => void) | undefined;

    void listen<QrScanProgressPayload>("qr-scan-progress", (event) => {
      const { path, phase, frame, frames_total } = event.payload;
      if (!path) return;
      if (
        phase === "extract" ||
        phase === "fast" ||
        phase === "thorough" ||
        phase === "frame"
      ) {
        const f = Number(frame) || 0;
        const t = Number(frames_total) || 0;
        if (t <= 0) return;
        setPhase(path, "active");
        if (phase === "extract") {
          const prev =
            useQrScanStore.getState().clipProgress[normalizeMediaPath(path)];
          // After the first Schnellprüfung tick, ignore further extract noise
          // so the counter does not flip back to "lesen" / 0.
          if (prev?.mode === "fast" || prev?.mode === "thorough") return;
          setClipProgress(path, 0, t, "prepare");
          return;
        }
        const mode = phase === "thorough" ? "thorough" : "fast";
        setClipProgress(path, f, t, mode);
        return;
      }
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
  }, [setPhase, setClipProgress, setFollowup]);
}

export function QrScanRowBar({ path }: { path: string }) {
  const phase = useQrScanStore((s) => s.byPath[normalizeMediaPath(path)] ?? null);
  if (!phase) return null;
  return <QrScanBar phase={phase} />;
}

/**
 * Compact QR status chip for photo tiles (overview / strip).
 * Only `active` + `hit` — pending/done stay as the bottom bar only.
 */
export function QrScanTileBadge({
  path,
  compact = false,
}: {
  path: string;
  /** Strip-sized tiles: icon only. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const phase = useQrScanStore((s) => s.byPath[normalizeMediaPath(path)] ?? null);
  if (phase !== "active" && phase !== "hit") return null;

  const isHit = phase === "hit";
  const title = isHit
    ? t("qr.progress.chipHitTitle")
    : t("qr.progress.chipActiveTitle");
  const label = isHit ? t("qr.progress.chipHit") : t("qr.progress.chipActive");

  return (
    <span
      className={
        isHit
          ? "inline-flex items-center gap-0.5 rounded bg-emerald-600 px-1 py-px text-[9px] font-bold leading-none text-white shadow-sm"
          : "inline-flex items-center gap-0.5 rounded bg-primary px-1 py-px text-[9px] font-bold leading-none text-primary-foreground shadow-sm animate-pulse"
      }
      title={title}
      aria-label={title}
    >
      <QrCode className="h-2.5 w-2.5 shrink-0" aria-hidden />
      {!compact && <span>{label}</span>}
    </span>
  );
}

export function QrScanBar({ phase }: { phase: QrScanPhase }) {
  const label =
    phase === "active"
      ? tr("media.drop.searchingQr")
      : phase === "pending"
        ? tr("qr.progress.pending")
        : phase === "hit"
          ? tr("qr.progress.found")
          : phase === "removed"
            ? tr("qr.progress.removed")
            : tr("qr.progress.checked");

  return (
    <div
      className={
        phase === "active"
          ? "ats-qr-scan-bar mt-1"
          : phase === "pending"
            ? "ats-qr-scan-bar ats-qr-scan-bar-pending mt-1"
            : phase === "hit"
              ? "ats-qr-scan-bar ats-qr-scan-bar-hit mt-1"
              : phase === "removed"
                ? "ats-qr-scan-bar ats-qr-scan-bar-removed mt-1"
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
