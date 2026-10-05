import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateJobResult } from "./tauri.ts";
import {
  buildCreateOutcomeRows,
  buildCreateRunOutcome,
  createOutcomeQueuePosition,
  type CreateSuccessInfo,
} from "./createRunOutcome.ts";

const t = (key: string, opts?: { count?: number }) =>
  opts?.count != null ? `${key}:${opts.count}` : key;

function info(over: Partial<CreateSuccessInfo> = {}): CreateSuccessInfo {
  return {
    result: {
      base_output_dir: "C:/out/Mueller",
      video_output: "C:/out/Mueller/Mueller.mp4",
      watermark_video: null,
      photos_copied: 3,
      watermark_photos: 0,
      reused_preview: false,
    } as unknown as CreateJobResult,
    ...over,
  };
}

describe("createRunOutcome", () => {
  it("drops the running-upload row only when embedded", () => {
    const running = info({ uploadInProgress: true, uploadJobId: "create-1" });
    const embedded = buildCreateOutcomeRows(running, t, { embedded: true });
    const standalone = buildCreateOutcomeRows(running, t, { embedded: false });
    assert.ok(!embedded.some((r) => r.label === "create.success.uploadRunning"));
    assert.ok(standalone.some((r) => r.label === "create.success.uploadRunning"));
    assert.equal(embedded[0].detail, "Mueller.mp4");
    assert.ok(embedded.some((r) => r.label === "create.success.photosCopiedMany:3"));
  });

  it("marks deferred and failed uploads as warning", () => {
    const deferred = buildCreateOutcomeRows(info({ uploadDeferred: true }), t, {
      embedded: false,
    });
    assert.equal(deferred.at(-1)?.tone, "warning");
    const failed = buildCreateOutcomeRows(
      info({ uploadFailed: true, uploadNote: "failed" }),
      t,
      { embedded: false },
    );
    assert.deepEqual(failed.at(-1), { label: "failed", tone: "warning" });
  });

  it("assigns unique ids", () => {
    assert.notEqual(buildCreateRunOutcome(info()).id, buildCreateRunOutcome(info()).id);
  });

  it("reports 1-based queue position only for waiting jobs", () => {
    assert.equal(createOutcomeQueuePosition("b", "a", ["x", "b"]), 2);
    assert.equal(createOutcomeQueuePosition("a", "a", ["b"]), null);
    assert.equal(createOutcomeQueuePosition("z", "a", ["b"]), null);
    assert.equal(createOutcomeQueuePosition(null, "a", []), null);
  });
});
