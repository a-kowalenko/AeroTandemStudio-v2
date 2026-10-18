import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendErrorReportsEnabled } from "./sendErrorReports.ts";

describe("sendErrorReportsEnabled", () => {
  it("defaults on when undefined (legacy / partial config)", () => {
    assert.equal(sendErrorReportsEnabled(undefined), true);
  });

  it("respects explicit true and false", () => {
    assert.equal(sendErrorReportsEnabled(true), true);
    assert.equal(sendErrorReportsEnabled(false), false);
  });
});
