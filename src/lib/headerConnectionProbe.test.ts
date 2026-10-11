/**
 * Pure helpers (plan file has no i18n/`@/` graph).
 * Live orchestration is covered by `npm run check` + header QA.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHeaderConnectionProbePlan,
  computeAllPrimaryOk,
  probeSuccessAutoCloseMs,
  shouldShowCloudProbeRow,
} from "./headerConnectionProbePlan.ts";

describe("buildHeaderConnectionProbePlan", () => {
  it("enables targets from config flags", () => {
    const plan = buildHeaderConnectionProbePlan({
      serverUrl: "smb://host/share",
      backupEnabled: true,
      backupUrl: "smb://host/backup",
      backupLogin: "u",
      backupPassword: "p",
      amsConfigured: true,
    });
    assert.equal(plan.runSmb, true);
    assert.equal(plan.runBackup, true);
    assert.equal(plan.backupUrl, "smb://host/backup");
    assert.equal(plan.runAms, true);
    assert.equal(plan.runCloud, true);
  });

  it("skips smb when URL empty and backup when disabled", () => {
    const plan = buildHeaderConnectionProbePlan({
      serverUrl: "  ",
      backupEnabled: false,
      backupUrl: "smb://x",
      backupLogin: "",
      backupPassword: "",
      amsConfigured: false,
    });
    assert.equal(plan.runSmb, false);
    assert.equal(plan.runBackup, false);
    assert.equal(plan.runAms, false);
  });
});

describe("probeSuccessAutoCloseMs", () => {
  it("uses longer delay for many rows", () => {
    assert.equal(probeSuccessAutoCloseMs(2), 3000);
    assert.equal(probeSuccessAutoCloseMs(3), 5000);
  });
});

describe("computeAllPrimaryOk", () => {
  const base = buildHeaderConnectionProbePlan({
    serverUrl: "smb://a",
    backupEnabled: true,
    backupUrl: "smb://b",
    backupLogin: "",
    backupPassword: "",
    amsConfigured: true,
  });

  it("requires smb, backup, and ams when planned", () => {
    assert.equal(
      computeAllPrimaryOk(
        base,
        { ok: true },
        { ok: true },
        { ok: true },
      ),
      true,
    );
    assert.equal(
      computeAllPrimaryOk(
        base,
        { ok: true },
        { ok: true },
        { ok: false },
      ),
      false,
    );
  });

  it("treats missing backup URL as not ok", () => {
    const plan = { ...base, backupUrl: "" };
    assert.equal(
      computeAllPrimaryOk(plan, { ok: true }, null, { ok: true }),
      false,
    );
  });

  it("ignores unplanned targets", () => {
    const plan = buildHeaderConnectionProbePlan({
      serverUrl: "smb://a",
      backupEnabled: false,
      backupUrl: "",
      backupLogin: "",
      backupPassword: "",
      amsConfigured: false,
    });
    assert.equal(computeAllPrimaryOk(plan, { ok: true }, null, null), true);
  });
});

describe("shouldShowCloudProbeRow", () => {
  it("hides no_token and shows other statuses", () => {
    assert.equal(shouldShowCloudProbeRow({ status: "no_token" }), false);
    assert.equal(shouldShowCloudProbeRow({ status: "ok" }), true);
    assert.equal(shouldShowCloudProbeRow({ status: "unreachable" }), true);
  });
});
