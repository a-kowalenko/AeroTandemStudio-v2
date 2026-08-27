import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canRetryVorgangUpload,
  isListUploadStatus,
  isOutstandingUploadState,
  isOutstandingVorgangUpload,
  isRetryableUploadState,
} from "../src/lib/uploadState.ts";

function entry(overrides = {}) {
  return {
    id: 1,
    correlation_id: "cid-1",
    base_output_dir: "C:/out/job",
    upload_state: "pending",
    ...overrides,
  };
}

describe("upload_state cancelled vs outstanding (Phase 31.8)", () => {
  it("cancelled is retryable but not outstanding", () => {
    assert.equal(isRetryableUploadState("cancelled"), true);
    assert.equal(isOutstandingUploadState("cancelled"), false);
    assert.equal(isOutstandingUploadState("pending"), true);
    assert.equal(isOutstandingUploadState("failed"), true);
  });

  it("badge / bulk exclude cancelled; Historie retry includes it", () => {
    const rows = [
      entry({ id: 1, upload_state: "pending" }),
      entry({ id: 2, upload_state: "failed", correlation_id: "cid-2" }),
      entry({ id: 3, upload_state: "cancelled", correlation_id: "cid-3" }),
      entry({ id: 4, upload_state: "done", correlation_id: "cid-4" }),
    ];

    assert.equal(
      rows.filter((e) => isOutstandingVorgangUpload(e, true)).length,
      2,
    );
    assert.equal(canRetryVorgangUpload(rows[2], true), true);
    assert.equal(canRetryVorgangUpload(rows[3], true), false);
  });

  it("list chip shows only actionable SMB states", () => {
    assert.equal(isListUploadStatus("uploading"), true);
    assert.equal(isListUploadStatus("pending"), true);
    assert.equal(isListUploadStatus("cancelled"), true);
    assert.equal(isListUploadStatus("failed"), true);
    assert.equal(isListUploadStatus("done"), false);
    assert.equal(isListUploadStatus("none"), false);
    assert.equal(isListUploadStatus(""), false);
  });
});
