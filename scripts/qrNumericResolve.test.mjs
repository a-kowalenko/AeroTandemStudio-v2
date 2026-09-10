/**
 * Numeric URL-only QR helpers — mirrored from src/lib/qrNumericResolve.tsx
 * for Node unit coverage without the Vite/TS frontend harness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function applyNumericQrIdsOnly(scanned) {
  const kunden_id = (scanned.kunden_id ?? "").trim() || null;
  const booking_id = (scanned.booking_id ?? "").trim() || null;
  return {
    ...scanned,
    kunden_id,
    booking_id,
    kunden_id_hash: null,
    booking_id_hash: null,
    vorname: null,
    nachname: null,
    email: null,
    telefon: null,
    gast: "",
    form_mode: "manual",
    video_mode: "",
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

function isSameNumericKunde(current, scanned) {
  const curK = (current.kunden_id ?? "").trim();
  const newK = (scanned.kunden_id ?? "").trim();
  const curB = (current.booking_id ?? "").trim();
  const newB = (scanned.booking_id ?? "").trim();
  return Boolean(curK && newK && curB && newB && curK === newK && curB === newB);
}

describe("qr numeric resolve helpers", () => {
  it("applyNumericQrIdsOnly keeps plain IDs and clears hashes/name", () => {
    const next = applyNumericQrIdsOnly({
      kunden_id: "1234",
      booking_id: "4567",
      kunden_id_hash: "h",
      booking_id_hash: "b",
      vorname: "X",
      nachname: "Y",
      gast: "X Y",
      form_mode: "kunde",
      handcam_video: true,
    });
    assert.equal(next.kunden_id, "1234");
    assert.equal(next.booking_id, "4567");
    assert.equal(next.kunden_id_hash, null);
    assert.equal(next.booking_id_hash, null);
    assert.equal(next.vorname, null);
    assert.equal(next.form_mode, "manual");
    assert.equal(next.handcam_video, false);
  });

  it("isSameNumericKunde matches id pairs", () => {
    assert.equal(
      isSameNumericKunde(
        { kunden_id: "1", booking_id: "2" },
        { kunden_id: "1", booking_id: "2" },
      ),
      true,
    );
    assert.equal(
      isSameNumericKunde(
        { kunden_id: "1", booking_id: "2" },
        { kunden_id: "1", booking_id: "9" },
      ),
      false,
    );
  });
});
