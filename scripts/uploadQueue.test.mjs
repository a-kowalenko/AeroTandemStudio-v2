import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelActiveUploadJob,
  clearActiveUploadJob,
  clearQueuedUploadJobs,
  createEmptyUploadQueue,
  enqueueUploadJob,
  formatUploadJobLine,
  promoteNextUploadJob,
  uploadQueueWorkCount,
} from "../src/lib/uploadQueue.ts";

function job(id, source = "create") {
  return {
    id,
    source,
    localDir: `/tmp/${id}`,
    folderName: id,
    correlationId: null,
    vorgangId: null,
  };
}

describe("uploadQueue FIFO", () => {
  it("enqueues in order and promotes first idle job", () => {
    let s = createEmptyUploadQueue();
    s = enqueueUploadJob(s, job("a"));
    s = enqueueUploadJob(s, job("b"));
    s = enqueueUploadJob(s, job("c"));
    assert.equal(s.active, null);
    assert.deepEqual(
      s.queue.map((j) => j.id),
      ["a", "b", "c"],
    );

    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "a");
    assert.deepEqual(
      s.queue.map((j) => j.id),
      ["b", "c"],
    );

    // Already active — no double promote.
    const again = promoteNextUploadJob(s);
    assert.equal(again.active?.id, "a");
    assert.deepEqual(
      again.queue.map((j) => j.id),
      ["b", "c"],
    );
  });

  it("after cancel of active, next promote starts following item", () => {
    let s = createEmptyUploadQueue();
    s = enqueueUploadJob(s, job("a"));
    s = enqueueUploadJob(s, job("b"));
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "a");

    const cancelled = cancelActiveUploadJob(s);
    assert.equal(cancelled.cancelled?.id, "a");
    s = cancelled.state;
    assert.equal(s.active, null);
    assert.deepEqual(
      s.queue.map((j) => j.id),
      ["b"],
    );

    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "b");
    assert.deepEqual(s.queue, []);
  });

  it("after fail/clear active, next item starts", () => {
    let s = createEmptyUploadQueue();
    s = enqueueUploadJob(s, job("a"));
    s = enqueueUploadJob(s, job("b"));
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "a");

    s = clearActiveUploadJob(s);
    assert.equal(s.active, null);
    assert.equal(uploadQueueWorkCount(s), 1);

    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "b");
    assert.equal(uploadQueueWorkCount(s), 1);
  });

  it("cancel with empty slot is a no-op", () => {
    const s = createEmptyUploadQueue();
    const result = cancelActiveUploadJob(s);
    assert.equal(result.cancelled, null);
    assert.equal(result.state.active, null);
  });

  it("clearQueued drops waiting jobs and keeps active", () => {
    let s = createEmptyUploadQueue();
    s = enqueueUploadJob(s, job("a"));
    s = enqueueUploadJob(s, job("b"));
    s = enqueueUploadJob(s, job("c"));
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "a");

    const cleared = clearQueuedUploadJobs(s);
    assert.deepEqual(
      cleared.cleared.map((j) => j.id),
      ["b", "c"],
    );
    assert.equal(cleared.state.active?.id, "a");
    assert.deepEqual(cleared.state.queue, []);
  });

  it("keeps create → history → bulk → append FIFO order (37.3)", () => {
    let s = createEmptyUploadQueue();
    s = enqueueUploadJob(s, job("c1", "create"));
    s = enqueueUploadJob(s, job("h1", "history"));
    s = enqueueUploadJob(s, job("b1", "bulk"));
    s = enqueueUploadJob(s, job("a1", "append"));

    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "c1");
    assert.equal(s.active?.source, "create");

    s = clearActiveUploadJob(s);
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "h1");
    assert.equal(s.active?.source, "history");

    s = clearActiveUploadJob(s);
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "b1");
    assert.equal(s.active?.source, "bulk");

    s = clearActiveUploadJob(s);
    s = promoteNextUploadJob(s);
    assert.equal(s.active?.id, "a1");
    assert.equal(s.active?.source, "append");
    assert.deepEqual(s.queue, []);
  });
});

describe("formatUploadJobLine", () => {
  const t = (key, opts) => {
    if (key === "history.ta") return `TA: ${opts.name}`;
    if (key === "history.vs") return `V: ${opts.name}`;
    if (key === "workflow.upload.queueUntitled") return "Upload";
    if (key === "workflow.stage.createUploading") return "Aktueller Vorgang";
    return key;
  };

  it("guest only", () => {
    assert.equal(
      formatUploadJobLine(
        {
          guestLabel: "Andreas Kowalenko",
          folderName: null,
          tandemmaster: null,
          videospringer: null,
        },
        t,
      ),
      "Andreas Kowalenko",
    );
  });

  it("guest with TA and VS like queue", () => {
    assert.equal(
      formatUploadJobLine(
        {
          guestLabel: "Andreas Kowalenko",
          folderName: "folder",
          tandemmaster: "Max",
          videospringer: "Ana",
        },
        t,
      ),
      "Andreas Kowalenko — TA: Max · V: Ana",
    );
  });

  it("guest with TA only", () => {
    assert.equal(
      formatUploadJobLine(
        {
          guestLabel: "Guest",
          folderName: null,
          tandemmaster: "Max",
          videospringer: null,
        },
        t,
      ),
      "Guest — TA: Max",
    );
  });

  it("untitled fallback for active subtitle", () => {
    assert.equal(
      formatUploadJobLine(
        {
          guestLabel: null,
          folderName: null,
          tandemmaster: "Max",
          videospringer: null,
        },
        t,
        "workflow.stage.createUploading",
      ),
      "Aktueller Vorgang — TA: Max",
    );
  });
});
