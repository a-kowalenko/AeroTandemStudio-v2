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
  /** Show real lookup thumb (same frame, before clone unmount). */
  onReveal: () => void;
  onComplete: () => void;
};

const FLIGHT_EASE = QR_LOOKUP_THUMB_FLIGHT_EASE;
const FLIGHT_MS = QR_LOOKUP_THUMB_FLIGHT_MS;

export function QrLookupThumbFlightClone({
  flight,
  destRef,
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
  const [phase, setPhase] = useState<"hold" | "fly">("hold");
  const doneRef = useRef(false);
  const onRevealRef = useRef(onReveal);
  const onCompleteRef = useRef(onComplete);
  onRevealRef.current = onReveal;
  onCompleteRef.current = onComplete;

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
    if (phase !== "hold") return;
    const reduced = prefersReducedMotion();
    const settleMs = reduced ? 0 : QR_LOOKUP_THUMB_FLIGHT_HOLD_MS;
    const id = window.setTimeout(() => {
      const next = rectFromDom(destRef.current);
      if (next) setDest(next);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setPhase("fly"));
      });
    }, settleMs);
    return () => window.clearTimeout(id);
  }, [destRef, flight.frameKey, phase]);

  useEffect(() => {
    if (phase !== "fly") return;
    const id = window.setTimeout(landSwap, FLIGHT_MS + 48);
    return () => window.clearTimeout(id);
  }, [phase, flight.frameKey]);

  useEffect(() => {
    const maxMs = QR_LOOKUP_THUMB_FLIGHT_HOLD_MS + FLIGHT_MS + 120;
    const id = window.setTimeout(finish, maxMs);
    return () => window.clearTimeout(id);
  }, [flight.frameKey]);

  const start = flight.start;
  const box = phase === "fly" && dest ? dest : start;
  const flying = phase === "fly";

  const node = (
    <div
      className={cn("ats-qr-lookup-thumb-flight", flying && "is-flying")}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        transition: flying
          ? `left ${FLIGHT_MS}ms ${FLIGHT_EASE}, top ${FLIGHT_MS}ms ${FLIGHT_EASE}, width ${FLIGHT_MS}ms ${FLIGHT_EASE}, height ${FLIGHT_MS}ms ${FLIGHT_EASE}`
          : "none",
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
