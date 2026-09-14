import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FOCUS_TARGET_AREA,
  coerceSettingsArea,
  isWizardStepSkippable,
  normalizeSettingsUiMode,
  resolveSettingsArea,
  settingsAreasForMode,
  showAdvanced,
  wizardStepsForMode,
  applySimpleWizardMediaDefaults,
  type SettingsDisclosure,
  type SettingsFocusTarget,
} from "./settingsUi.ts";

describe("resolveSettingsArea", () => {
  it("maps legacy tabs onto the five areas", () => {
    assert.equal(resolveSettingsArea("allgemein"), "workplace");
    assert.equal(resolveSettingsArea("crew"), "workplace");
    assert.equal(resolveSettingsArea("qr"), "media");
    assert.equal(resolveSettingsArea("sd"), "media");
    assert.equal(resolveSettingsArea("server"), "connection");
    assert.equal(resolveSettingsArea("encoding"), "output");
    assert.equal(resolveSettingsArea("system"), "maintenance");
  });

  it("keeps new area IDs", () => {
    assert.equal(resolveSettingsArea("workplace"), "workplace");
    assert.equal(resolveSettingsArea("media"), "media");
    assert.equal(resolveSettingsArea("connection"), "connection");
    assert.equal(resolveSettingsArea("output"), "output");
    assert.equal(resolveSettingsArea("maintenance"), "maintenance");
  });

  it("falls back to workplace", () => {
    assert.equal(resolveSettingsArea(undefined), "workplace");
    assert.equal(resolveSettingsArea(""), "workplace");
    assert.equal(resolveSettingsArea("unknown"), "workplace");
  });
});

describe("focus targets", () => {
  const targets: SettingsFocusTarget[] = [
    "server-url",
    "server-credentials",
    "server-backup-url",
    "ams-bridge-url",
    "ams-bridge-token",
  ];

  it("keep every current deep-link on connection", () => {
    for (const target of targets) {
      assert.equal(FOCUS_TARGET_AREA[target], "connection");
    }
  });
});

describe("settingsAreasForMode", () => {
  it("omits output in simple mode", () => {
    assert.deepEqual(settingsAreasForMode("simple"), [
      "workplace",
      "media",
      "connection",
      "maintenance",
    ]);
  });

  it("keeps all five areas in advanced mode", () => {
    assert.deepEqual(settingsAreasForMode("advanced"), [
      "workplace",
      "media",
      "connection",
      "output",
      "maintenance",
    ]);
  });

  it("falls back from output to workplace in simple mode", () => {
    assert.equal(coerceSettingsArea("output", "simple"), "workplace");
    assert.equal(coerceSettingsArea("output", "advanced"), "output");
    assert.equal(coerceSettingsArea("media", "simple"), "media");
  });
});

describe("showAdvanced", () => {
  it("shows advanced controls in advanced mode", () => {
    const disclosure: SettingsDisclosure = {
      uiMode: "advanced",
      revealedFocus: null,
    };
    assert.equal(showAdvanced(disclosure), true);
  });

  it("hides advanced controls in simple mode", () => {
    const disclosure: SettingsDisclosure = {
      uiMode: "simple",
      revealedFocus: null,
    };
    assert.equal(showAdvanced(disclosure), false);
  });

  it("temporarily reveals a focused advanced field without flipping mode", () => {
    const disclosure: SettingsDisclosure = {
      uiMode: "simple",
      revealedFocus: "server-backup-url",
    };
    assert.equal(showAdvanced(disclosure, ["server-backup-url"]), true);
    assert.equal(showAdvanced(disclosure, ["ams-bridge-token"]), false);
    assert.equal(disclosure.uiMode, "simple");
  });
});

describe("wizardStepsForMode", () => {
  it("skips storage + media on the simple path (defaults adopted)", () => {
    assert.deepEqual(wizardStepsForMode("simple"), [
      "mode",
      "workplace",
      "connection",
      "finish",
    ]);
  });

  it("adds output on the custom path", () => {
    assert.deepEqual(wizardStepsForMode("advanced"), [
      "mode",
      "workplace",
      "storage",
      "media",
      "connection",
      "output",
      "finish",
    ]);
  });

  it("does not allow skipping mode or finish", () => {
    assert.equal(isWizardStepSkippable("mode"), false);
    assert.equal(isWizardStepSkippable("finish"), false);
    assert.equal(isWizardStepSkippable("storage"), true);
    assert.equal(isWizardStepSkippable("output"), true);
  });
});

describe("applySimpleWizardMediaDefaults", () => {
  it("turns every media workflow toggle on", () => {
    const next = applySimpleWizardMediaDefaults({
      qr_check_enabled: false,
      photo_qr_check_enabled: false,
      sd_auto_backup: false,
      sd_auto_import: false,
      sd_eject_after_workflow: false,
      upload_to_server: false,
    });
    assert.equal(next.qr_check_enabled, true);
    assert.equal(next.photo_qr_check_enabled, true);
    assert.equal(next.sd_auto_backup, true);
    assert.equal(next.sd_auto_import, true);
    assert.equal(next.sd_eject_after_workflow, true);
    assert.equal(next.upload_to_server, true);
  });
});

describe("normalizeSettingsUiMode", () => {
  it("treats anything except advanced as simple", () => {
    assert.equal(normalizeSettingsUiMode("advanced"), "advanced");
    assert.equal(normalizeSettingsUiMode("simple"), "simple");
    assert.equal(normalizeSettingsUiMode(""), "simple");
    assert.equal(normalizeSettingsUiMode(undefined), "simple");
  });
});
