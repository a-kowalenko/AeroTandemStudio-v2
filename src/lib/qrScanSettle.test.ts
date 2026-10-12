import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasQrCarrierLiveThumb,
  retainHitRemovedLiveFrames,
  settleByPathAfterHit,
  type QrSettlePhase,
} from "./qrScanSettle.ts";

describe("settleByPathAfterHit", () => {
  it("marks pending/active siblings done and keeps the hit", () => {
    const byPath: Record<string, QrSettlePhase> = {
      a: "active",
      b: "pending",
      c: "hit",
      d: "done",
    };
    assert.deepEqual(settleByPathAfterHit(byPath, "c"), {
      a: "done",
      b: "done",
      c: "hit",
      d: "done",
    });
  });

  it("does not overwrite removed", () => {
    const byPath: Record<string, QrSettlePhase> = {
      a: "active",
      b: "removed",
    };
    assert.deepEqual(settleByPathAfterHit(byPath, "b"), {
      a: "done",
      b: "removed",
    });
  });
});

describe("retainHitRemovedLiveFrames", () => {
  it("drops scan/miss thumbs", () => {
    const next = retainHitRemovedLiveFrames([
      { key: "a", tone: "scan" },
      { key: "b", tone: "hit" },
      { key: "c", tone: "miss" },
      { key: "d", tone: "removed" },
    ]);
    assert.deepEqual(
      next.map((f) => f.key),
      ["b", "d"],
    );
  });
});

describe("hasQrCarrierLiveThumb", () => {
  it("is true while hit/removed/scan thumbs remain", () => {
    assert.equal(hasQrCarrierLiveThumb([{ tone: "removed" }]), true);
    assert.equal(hasQrCarrierLiveThumb([{ tone: "hit" }]), true);
    assert.equal(hasQrCarrierLiveThumb([{ tone: "scan" }]), true);
    assert.equal(hasQrCarrierLiveThumb([{ tone: "miss" }]), false);
    assert.equal(hasQrCarrierLiveThumb([]), false);
  });
});
