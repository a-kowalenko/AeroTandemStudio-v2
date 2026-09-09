/**
 * Pure dual-family QR helpers (Phase 45) — mirrored from src/lib/qrDualResolve.ts
 * for Node unit coverage without the Vite/TS frontend harness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function applyOfflineDualFamily(qr, videoMode) {
  return {
    ...qr,
    kunden_id: null,
    booking_id: null,
    form_mode: "kunde",
    video_mode: videoMode,
    handcam_foto: false,
    handcam_video: false,
    outside_foto: false,
    outside_video: false,
    ist_bezahlt_handcam_foto: false,
    ist_bezahlt_handcam_video: false,
    ist_bezahlt_outside_foto: false,
    ist_bezahlt_outside_video: false,
  };
}

function applyAmsHitToQrKunde(qr, hit, videoMode) {
  const vorname = (hit.first_name ?? "").trim() || qr.vorname;
  const nachname = (hit.last_name ?? "").trim() || qr.nachname;
  const gast = [vorname, nachname].filter(Boolean).join(" ").trim() || qr.gast;
  return {
    ...qr,
    kunden_id: null,
    booking_id: null,
    kunden_id_hash: qr.kunden_id_hash ?? null,
    booking_id_hash: qr.booking_id_hash ?? null,
    vorname,
    nachname,
    gast,
    form_mode: "kunde",
    video_mode: videoMode,
    handcam_foto: Boolean(hit.handcam_foto),
    handcam_video: Boolean(hit.handcam_video),
    outside_foto: Boolean(hit.outside_foto),
    outside_video: Boolean(hit.outside_video),
    ist_bezahlt_handcam_foto: Boolean(hit.ist_bezahlt_handcam_foto),
    ist_bezahlt_handcam_video: Boolean(hit.ist_bezahlt_handcam_video),
    ist_bezahlt_outside_foto: Boolean(hit.ist_bezahlt_outside_foto),
    ist_bezahlt_outside_video: Boolean(hit.ist_bezahlt_outside_video),
  };
}

function classifyTypedHits(opts) {
  const has = (c) =>
    Boolean(c?.handcam_foto || c?.handcam_video || c?.outside_foto || c?.outside_video);
  const h = opts.handcam && has(opts.handcam) ? opts.handcam : null;
  const o = opts.outside && has(opts.outside) ? opts.outside : null;
  if (h && o) return { kind: "choice", handcam: h, outside: o };
  if (h) return { kind: "one", customer: h, videoMode: "handcam" };
  if (o) return { kind: "one", customer: o, videoMode: "outside" };
  return { kind: "none" };
}

const baseQr = {
  kunden_id: "999",
  booking_id: "888",
  kunden_id_hash: "hashCust",
  booking_id_hash: "hashBook",
  vorname: "Max",
  nachname: "Mustermann",
  gast: "Max Mustermann",
  form_mode: "kunde",
  video_mode: "",
  handcam_foto: false,
  handcam_video: false,
  outside_foto: false,
  outside_video: false,
};

describe("qr dual resolve helpers", () => {
  it("classifyTypedHits asks when both families have media", () => {
    const classified = classifyTypedHits({
      handcam: { handcam_video: true },
      outside: { outside_foto: true },
    });
    assert.equal(classified.kind, "choice");
  });

  it("classifyTypedHits picks single family", () => {
    const classified = classifyTypedHits({
      handcam: null,
      outside: { outside_video: true },
    });
    assert.equal(classified.kind, "one");
    assert.equal(classified.videoMode, "outside");
  });

  it("applyAmsHitToQrKunde keeps hashes and form_mode kunde", () => {
    const next = applyAmsHitToQrKunde(
      baseQr,
      {
        first_name: "Anna",
        last_name: "S",
        handcam_foto: true,
        handcam_video: true,
        outside_foto: false,
        outside_video: false,
        ist_bezahlt_handcam_foto: true,
        ist_bezahlt_handcam_video: false,
      },
      "handcam",
    );
    assert.equal(next.form_mode, "kunde");
    assert.equal(next.kunden_id, null);
    assert.equal(next.booking_id, null);
    assert.equal(next.kunden_id_hash, "hashCust");
    assert.equal(next.booking_id_hash, "hashBook");
    assert.equal(next.vorname, "Anna");
    assert.equal(next.video_mode, "handcam");
    assert.equal(next.handcam_foto, true);
    assert.equal(next.handcam_video, true);
  });

  it("applyOfflineDualFamily sets mode and clears flags", () => {
    const next = applyOfflineDualFamily(baseQr, "outside");
    assert.equal(next.video_mode, "outside");
    assert.equal(next.form_mode, "kunde");
    assert.equal(next.handcam_foto, false);
    assert.equal(next.outside_video, false);
    assert.equal(next.kunden_id_hash, "hashCust");
  });
});
