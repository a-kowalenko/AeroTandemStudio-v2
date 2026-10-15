/** Fixed-position FLIP clone: strip thumb → lookup thumb slot (portaled to body). */

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { mediaKind } from "@/lib/media";
import { previewRotateCoverStyles } from "@/lib/mediaPreviewRotate";
import {
  prefersReducedMotion,
  QR_LOOKUP_THUMB_FLIGHT_EASE,
  QR_LOOKUP_THUMB_FLIGHT_MS,
  QR_LOOKUP_THUMB_FLIGHT_HOLD_MS,
  rectFromDom,
  type QrLookupThumbFlightRect,
  type QrLookupThumbFlightState,
} from "@/lib/qrLookupThumbFlight";
import { cn } from "@/lib/utils";
import { useVideoStore } from "@/store/videoStore";

type Props = {
  flight: QrLookupThumbFlightState;
  destRef: RefObject<HTMLElement | null>;
  /** Strip/scan chrome shut + carrier drop — same moment as glide (500ms). */
  onGlideStart?: () => void;
  /** Show real lookup thumb (same frame, before clone unmount). */
  onReveal: () => void;
  onComplete: () => void;
};

const FLIGHT_EASE = QR_LOOKUP_THUMB_FLIGHT_EASE;
const FLIGHT_MS = QR_LOOKUP_THUMB_FLIGHT_MS;

export function QrLookupThumbFlightClone({
  flight,
  destRef,
  onGlideStart,
  onReveal,
  onComplete,
}: Props) {
  const mediaPath = flight.mediaPath.trim();
  const rotateDeg = useVideoStore((s) =>
    mediaPath && mediaKind(mediaPath) === "video"
      ? s.getRotation(mediaPath)
      : 0,
  );
  const rotate = previewRotateCoverStyles(rotateDeg);
  const src = `${convertFileSrc(flight.path)}${flight.gen > 0 ? `?g=${flight.gen}` : ""}`;
  const [dest, setDest] = useState<QrLookupThumbFlightRect | null>(null);
  const [phase, setPhase] = useState<"hold" | "preflight" | "fly">("hold");
  const doneRef = useRef(false);
  const glideStartedRef = useRef(false);
  const onRevealRef = useRef(onReveal);
  const onCompleteRef = useRef(onComplete);
  const onGlideStartRef = useRef(onGlideStart);
  onRevealRef.current = onReveal;
  onCompleteRef.current = onComplete;
  onGlideStartRef.current = onGlideStart;

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCompleteRef.current();
  };

  const landSwap = () => {
    if (doneRef.current) return;
    onRevealRef.current();
    window.requestAnimationFrame(() => finish());
  };

  useLayoutEffect(() => {
    const next = rectFromDom(destRef.current);
    if (next) setDest((prev) => prev ?? next);
  }, [destRef, flight.frameKey]);

  useLayoutEffect(() => {
    if (phase !== "hold") return;
    const reduced = prefersReducedMotion();
    const settleMs = reduced ? 0 : QR_LOOKUP_THUMB_FLIGHT_HOLD_MS;
    const id = window.setTimeout(() => {
      const next = rectFromDom(destRef.current);
      if (next) setDest(next);
      setPhase("preflight");
    }, settleMs);
    return () => window.clearTimeout(id);
  }, [destRef, flight.frameKey, phase]);

  useLayoutEffect(() => {
    if (phase !== "preflight") return;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setPhase("fly"));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [phase, flight.frameKey]);

  useLayoutEffect(() => {
    if (phase !== "fly") return;
    if (glideStartedRef.current) return;
    glideStartedRef.current = true;
    onGlideStartRef.current?.();
  }, [phase, flight.frameKey]);

  useEffect(() => {
    if (phase !== "fly") return;
    const id = window.setTimeout(landSwap, FLIGHT_MS + 48);
    return () => window.clearTimeout(id);
  }, [phase, flight.frameKey]);

  useEffect(() => {
    const maxMs = QR_LOOKUP_THUMB_FLIGHT_HOLD_MS + FLIGHT_MS + 160;
    const id = window.setTimeout(finish, maxMs);
    return () => window.clearTimeout(id);
  }, [flight.frameKey]);

  const start = flight.start;
  const box = phase === "fly" && dest ? dest : start;
  const flying = phase === "fly";
  const glideReady = phase === "preflight" || phase === "fly";
  const transition = glideReady
    ? `left ${FLIGHT_MS}ms ${FLIGHT_EASE}, top ${FLIGHT_MS}ms ${FLIGHT_EASE}, width ${FLIGHT_MS}ms ${FLIGHT_EASE}, height ${FLIGHT_MS}ms ${FLIGHT_EASE}`
    : "none";

  const node = (
    <div
      className={cn("ats-qr-lookup-thumb-flight", flying && "is-flying")}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        transition,
      }}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === "fly" && e.propertyName === "width") {
          landSwap();
        }
      }}
      aria-hidden
    >
      <div className="ats-qr-lookup-thumb-flight-media" style={rotate.container}>
        <img
          src={src}
          alt=""
          className="ats-qr-lookup-thumb-flight-img"
          style={rotate.media}
          draggable={false}
        />
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
