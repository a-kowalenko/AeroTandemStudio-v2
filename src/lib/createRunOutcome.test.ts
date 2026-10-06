import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateJobResult } from "./tauri.ts";
import {
  buildCreateOutcomeEmbeddedMeta,
  buildCreateOutcomeRows,
  buildCreateRunOutcome,
  createOutcomeCrewLine,
  createOutcomeQueuePosition,
  createOutcomeSuccessTitleKey,
  createOutcomeSuppressesUploadDoneToast,
  type CreateSuccessInfo,
} from "./createRunOutcome.ts";

const t = (key: string, opts?: { count?: number; name?: string }) => {
  if (opts?.count != null) return `${key}:${opts.count}`;
  if (opts?.name != null) return `${key}:${opts.name}`;
  return key;
};

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
    assert.equal(embedded[0].detail, undefined);
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

  it("switches success title after server upload", () => {
    assert.equal(createOutcomeSuccessTitleKey({}), "create.success.title");
    assert.equal(
      createOutcomeSuccessTitleKey({ serverUploaded: true }),
      "create.success.uploadTitle",
    );
  });

  it("suppresses done toast only while outcome is bound to the job", () => {
    const outcome = buildCreateRunOutcome(info({ uploadJobId: "create-1" }));
    assert.equal(createOutcomeSuppressesUploadDoneToast(outcome, "create-1"), true);
    assert.equal(createOutcomeSuppressesUploadDoneToast(outcome, "other"), false);
    assert.equal(createOutcomeSuppressesUploadDoneToast(null, "create-1"), false);
  });

  it("omits the uploaded row when server upload succeeded", () => {
    const rows = buildCreateOutcomeRows(
      info({ serverUploaded: true }),
      t,
      { embedded: false },
    );
    assert.ok(!rows.some((r) => r.label === "create.success.uploaded"));
  });

  it("builds embedded meta without an upload bullet", () => {
    assert.deepEqual(
      buildCreateOutcomeEmbeddedMeta(info({ serverUploaded: true }), t),
      ["create.success.videoCreated", "create.success.photosCopiedMany:3"],
    );
  });

  it("formats crew line from set roles only", () => {
    assert.equal(createOutcomeCrewLine({}, t), "");
    assert.equal(
      createOutcomeCrewLine({ tandemmaster: "Ada", videospringer: " Bob " }, t),
      "create.success.crewTm:Ada · create.success.crewVs:Bob",
    );
  });
});
