import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DialogActionStatus } from "../store/uiStore.ts";
import {
  SESSION_OUTCOME_HIDE_MS,
  SESSION_OUTCOME_HIDE_QUEUED_MS,
  SESSION_OUTCOME_HIDE_WARNING_MS,
  buildSessionRunOutcome,
  sessionOutcomeHideMs,
  sessionRunOutcomeTone,
} from "./sessionRunOutcome.ts";

function row(
  over: Partial<DialogActionStatus> & Pick<DialogActionStatus, "kind" | "tone">,
): DialogActionStatus {
  return {
    label: over.kind,
    summary: over.tone,
    ...over,
  };
}

describe("sessionRunOutcome", () => {
  it("uses warning tone when any row is warning or error", () => {
    assert.equal(
      sessionRunOutcomeTone([
        row({ kind: "import", tone: "success" }),
        row({ kind: "clear", tone: "warning" }),
      ]),
      "warning",
    );
    assert.equal(
      sessionRunOutcomeTone([row({ kind: "eject", tone: "error" })]),
      "warning",
    );
    assert.equal(
      sessionRunOutcomeTone([
        row({ kind: "import", tone: "success" }),
        row({ kind: "qr", tone: "skipped" }),
      ]),
      "success",
    );
  });

  it("hides sooner when queued; warning stays longer when not queued", () => {
    assert.equal(
      sessionOutcomeHideMs({ queuedNext: false }),
      SESSION_OUTCOME_HIDE_MS,
    );
    assert.equal(
      sessionOutcomeHideMs({ queuedNext: true }),
      SESSION_OUTCOME_HIDE_QUEUED_MS,
    );
    assert.equal(
      sessionOutcomeHideMs({ tone: "warning" }),
      SESSION_OUTCOME_HIDE_WARNING_MS,
    );
    assert.equal(
      sessionOutcomeHideMs({ queuedNext: true, tone: "warning" }),
      SESSION_OUTCOME_HIDE_QUEUED_MS,
    );
  });

  it("assigns a unique id and copies actions", () => {
    const actions = [row({ kind: "import", tone: "success" })];
    const a = buildSessionRunOutcome({ title: "OK", actions });
    const b = buildSessionRunOutcome({
      title: " QR ",
      highlight: "  Müller  ",
      actions,
      queuedNext: true,
      qrPreview: {
        path: "C:/tmp/qr.jpg",
        width: 1920,
        height: 1080,
        spotlight: null,
      },
    });
    assert.notEqual(a.id, b.id);
    assert.equal(b.title, "QR");
    assert.equal(b.highlight, "Müller");
    assert.equal(b.queuedNext, true);
    assert.equal(b.qrPreview?.path, "C:/tmp/qr.jpg");
    assert.equal(a.qrPreview, null);
    assert.notEqual(a.actions, actions);
    actions.push(row({ kind: "qr", tone: "warning" }));
    assert.equal(a.actions.length, 1);
  });

  it("drops qrPreview without a path", () => {
    const o = buildSessionRunOutcome({
      title: "OK",
      actions: [row({ kind: "import", tone: "success" })],
      qrPreview: { path: "  ", width: 1, height: 1, spotlight: null },
    });
    assert.equal(o.qrPreview, null);
  });

  it("supports hold and stable id for in-place updates", () => {
    const first = buildSessionRunOutcome({
      title: "QR",
      hold: true,
      actions: [row({ kind: "ams", tone: "success" })],
    });
    assert.equal(first.hold, true);
    const second = buildSessionRunOutcome({
      title: "QR",
      hold: false,
      id: first.id,
      actions: [row({ kind: "qr", tone: "success" })],
    });
    assert.equal(second.id, first.id);
    assert.equal(second.hold, false);
  });
});
