import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Eraser, QrCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { fileBaseName } from "@/lib/qrSuccess";
import {
  useQrScanStore,
  type QrLiveFrame,
  type QrLiveTone,
} from "@/store/qrScanStore";

const MISS_HOLD_MS = 420;
const REMOVED_HOLD_MS = 720;

function liveSrc(frame: QrLiveFrame): string {
  return `${convertFileSrc(frame.livePath)}?g=${frame.gen}`;
}

function LiveTile({ frame }: { frame: QrLiveFrame }) {
  const { t } = useTranslation();
  const clearLiveFrame = useQrScanStore((s) => s.clearLiveFrame);
  const src = liveSrc(frame);
  const [shownSrc, setShownSrc] = useState(src);
  const [fadeKey, setFadeKey] = useState(frame.gen);
  const name = fileBaseName(frame.mediaPath);
  const tone = frame.tone;

  useEffect(() => {
    if (src === shownSrc) return;
    setShownSrc(src);
    setFadeKey(frame.gen);
  }, [src, shownSrc, frame.gen]);

  useEffect(() => {
    if (tone !== "miss" && tone !== "removed") return;
    const ms = tone === "removed" ? REMOVED_HOLD_MS : MISS_HOLD_MS;
    const id = window.setTimeout(() => clearLiveFrame(frame.mediaPath), ms);
    return () => window.clearTimeout(id);
  }, [tone, frame.mediaPath, clearLiveFrame]);

  const badge =
    tone === "hit"
      ? t("qr.progress.liveHit")
      : tone === "removed"
        ? t("qr.progress.liveRemoved")
        : tone === "miss"
          ? t("qr.progress.liveMiss")
          : t("qr.progress.liveScanning");

  return (
    <div
      className={cn("ats-qr-live-tile", toneClass(tone))}
      data-tone={tone}
      title={`${name} — ${badge}`}
    >
      <img
        key={fadeKey}
        src={shownSrc}
        alt={t("qr.progress.liveAlt", { name })}
        className="ats-qr-live-img"
        draggable={false}
      />
      <div className="ats-qr-live-vignette" aria-hidden />
      {tone === "scan" ? (
        <>
          <span className="ats-qr-live-scanline" aria-hidden />
          <span className="ats-qr-live-reticle" aria-hidden />
        </>
      ) : null}
      {tone === "removed" ? (
        <span className="ats-qr-live-wipe" aria-hidden />
      ) : null}
      <span className="ats-qr-live-badge">
        {tone === "hit" ? (
          <Check className="h-3 w-3" aria-hidden />
        ) : tone === "removed" ? (
          <Eraser className="h-3 w-3" aria-hidden />
        ) : (
          <QrCode className="h-3 w-3" aria-hidden />
        )}
        <span>{badge}</span>
      </span>
    </div>
  );
}

function toneClass(tone: QrLiveTone): string {
  if (tone === "hit") return "ats-qr-live-tile-hit";
  if (tone === "miss") return "ats-qr-live-tile-miss";
  if (tone === "removed") return "ats-qr-live-tile-removed";
  return "ats-qr-live-tile-scan";
}

/** Live decode-frame strip in the QR progress panel. */
export function QrLiveScanStrip() {
  const { t } = useTranslation();
  const busy = useQrScanStore((s) => s.busy);
  const frames = useQrScanStore((s) => s.liveFrames);
  if (!busy || frames.length === 0) return null;

  return (
    <div
      className="ats-qr-live-strip"
      role="group"
      aria-label={t("qr.progress.liveAria")}
    >
      {frames.map((frame) => (
        <LiveTile key={frame.key} frame={frame} />
      ))}
    </div>
  );
}
