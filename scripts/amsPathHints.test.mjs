import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AMS_BACKUP_PROFILE_ID,
  bindPathHintsServerInstance,
  buildPathHintsDriftDismissState,
  computePathHintsDiff,
  DEFAULT_SERVER_URL,
  isPlaceholderServerUrl,
  normalizeSmbUrlForCompare,
  parsePathHintsFromHealth,
  pathHintsApplyInstanceAllowed,
  pathHintsDriftFacets,
  pathHintsDriftSignature,
  pathHintsHintsSignature,
  PATHS_V1_CAPABILITY,
  shouldSuppressPathHintsDriftBanner,
} from "../src/lib/amsPathHintsCore.ts";
import {
  applyPathHintsToConfigWire,
  credentialPromptPlan,
  copyPrimaryCredsToBackupProfileWire,
} from "../src/lib/amsPathHintsApplyCore.ts";

describe("amsPathHints", () => {
  it("treats empty and default URL as placeholder", () => {
    assert.ok(isPlaceholderServerUrl(""));
    assert.ok(isPlaceholderServerUrl("   "));
    assert.ok(isPlaceholderServerUrl(DEFAULT_SERVER_URL));
    assert.ok(
      isPlaceholderServerUrl("SMB://169.254.169.254/aktuell"),
    );
    assert.ok(!isPlaceholderServerUrl("smb://10.0.0.1/share"));
  });

  it("normalizes UNC and smb schemes for compare", () => {
    assert.equal(
      normalizeSmbUrlForCompare("\\\\169.254.169.254\\aktuell"),
      "smb://169.254.169.254/aktuell",
    );
    assert.equal(
      normalizeSmbUrlForCompare("//host/share"),
      "smb://host/share",
    );
    assert.equal(
      normalizeSmbUrlForCompare("SMB://Host/Share"),
      "smb://Host/Share",
    );
  });

  it("parses hints only with paths-v1 and primary", () => {
    assert.equal(parsePathHintsFromHealth(null), null);
    assert.equal(
      parsePathHintsFromHealth({
        online: true,
        version: "1",
        monitor_path: "D:\\x",
        capabilities: [],
      }),
      null,
    );
    const hints = parsePathHintsFromHealth({
      online: true,
      version: "1",
      monitor_path: "D:\\x",
      capabilities: [PATHS_V1_CAPABILITY],
      ats_paths: {
        primary_smb_url: "\\\\169.254.169.254\\aktuell",
        backup_smb_url: "smb://169.254.169.254/aktuell-backup",
      },
    });
    assert.deepEqual(hints, {
      primarySmbUrl: "smb://169.254.169.254/aktuell",
      backupSmbUrl: "smb://169.254.169.254/aktuell-backup",
    });
  });

  it("diff: suggest for placeholder, drift for mismatch, match when equal", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const baseConfig = {
      server_url: DEFAULT_SERVER_URL,
      server_profiles: [
        { id: "default", label: "x", url: DEFAULT_SERVER_URL, login: "", password: "" },
        {
          id: AMS_BACKUP_PROFILE_ID,
          label: "backup",
          url: "",
          login: "",
          password: "",
        },
      ],
    };

    assert.equal(computePathHintsDiff(baseConfig, hints).kind, "suggest");

    const drift = computePathHintsDiff(
      { ...baseConfig, server_url: "smb://other/share" },
      hints,
    );
    assert.equal(drift.kind, "drift");

    const match = computePathHintsDiff(
      {
        ...baseConfig,
        server_url: hints.primarySmbUrl,
        server_profiles: [
          baseConfig.server_profiles[0],
          {
            ...baseConfig.server_profiles[1],
            url: hints.backupSmbUrl,
          },
        ],
      },
      hints,
    );
    assert.equal(match.kind, "match");
  });

  it("drift facets: primary only, backup only, both", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const primaryOnly = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        server_profiles: [
          { id: AMS_BACKUP_PROFILE_ID, url: hints.backupSmbUrl },
        ],
      },
      hints,
    );
    assert.deepEqual(pathHintsDriftFacets(primaryOnly), {
      primary: true,
      backup: false,
    });

    const backupOnly = computePathHintsDiff(
      {
        server_url: hints.primarySmbUrl,
        server_profiles: [{ id: AMS_BACKUP_PROFILE_ID, url: "smb://x/old" }],
      },
      hints,
    );
    assert.deepEqual(pathHintsDriftFacets(backupOnly), {
      primary: false,
      backup: true,
    });

    const both = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        server_profiles: [{ id: AMS_BACKUP_PROFILE_ID, url: "smb://x/old" }],
      },
      hints,
    );
    assert.deepEqual(pathHintsDriftFacets(both), {
      primary: true,
      backup: true,
    });
  });

  it("apply: sets primary url and creates ams-backup profile", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const config = {
      server_url: DEFAULT_SERVER_URL,
      active_server_profile_id: "default",
      server_login: "user",
      server_password: "pass",
      server_profiles: [
        { id: "default", url: DEFAULT_SERVER_URL, login: "user", password: "pass" },
      ],
    };
    const applied = applyPathHintsToConfigWire(config, hints, "AMS Backup");
    assert.equal(applied.server_url, hints.primarySmbUrl);
    const backup = applied.server_profiles.find((p) => p.id === AMS_BACKUP_PROFILE_ID);
    assert.ok(backup);
    assert.equal(backup.url, hints.backupSmbUrl);
    assert.equal(backup.label, "AMS Backup");
  });

  it("credential matrix: guest ok needs no prompt", () => {
    assert.equal(
      credentialPromptPlan({ primaryOk: true, backupOk: true }, true),
      "none",
    );
    assert.equal(
      credentialPromptPlan({ primaryOk: true, backupOk: null }, false),
      "none",
    );
  });

  it("credential matrix: primary fail backup ok → primary only", () => {
    assert.equal(
      credentialPromptPlan({ primaryOk: false, backupOk: true }, true),
      "primary",
    );
  });

  it("credential matrix: primary ok backup fail → backup only", () => {
    assert.equal(
      credentialPromptPlan({ primaryOk: true, backupOk: false }, true),
      "backup",
    );
  });

  it("copy primary creds into backup profile", () => {
    const next = copyPrimaryCredsToBackupProfileWire({
      server_login: "a",
      server_password: "b",
      server_profiles: [
        { id: AMS_BACKUP_PROFILE_ID, url: "smb://x/backup" },
      ],
    });
    const backup = next.server_profiles.find((p) => p.id === AMS_BACKUP_PROFILE_ID);
    assert.equal(backup.login, "a");
    assert.equal(backup.password, "b");
  });

  it("drift signature and dismiss suppress until hints or config change", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const diff = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        server_profiles: [{ id: AMS_BACKUP_PROFILE_ID, url: "smb://x/old" }],
      },
      hints,
    );
    assert.equal(diff.kind, "drift");
    const sig = pathHintsDriftSignature(diff);
    assert.ok(sig.includes(hints.primarySmbUrl));
    const dismiss = buildPathHintsDriftDismissState(diff);
    assert.ok(dismiss);
    assert.equal(dismiss.hintsKey, pathHintsHintsSignature(hints));
    assert.ok(shouldSuppressPathHintsDriftBanner(diff, dismiss));

    const newHints = {
      ...hints,
      primarySmbUrl: "smb://10.0.0.6/aktuell",
    };
    const afterHintChange = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        server_profiles: [{ id: AMS_BACKUP_PROFILE_ID, url: "smb://x/old" }],
      },
      newHints,
    );
    assert.ok(!shouldSuppressPathHintsDriftBanner(afterHintChange, dismiss));

    const afterUserEdit = computePathHintsDiff(
      {
        server_url: "smb://user-edited/share",
        server_profiles: [{ id: AMS_BACKUP_PROFILE_ID, url: "smb://x/old" }],
      },
      hints,
    );
    assert.ok(!shouldSuppressPathHintsDriftBanner(afterUserEdit, dismiss));
  });

  it("instance_id guard: allow empty or match, block mismatch", () => {
    assert.ok(pathHintsApplyInstanceAllowed("", "live-1"));
    assert.ok(pathHintsApplyInstanceAllowed("saved-1", ""));
    assert.ok(pathHintsApplyInstanceAllowed("", ""));
    assert.ok(pathHintsApplyInstanceAllowed("inst-a", "inst-a"));
    assert.ok(!pathHintsApplyInstanceAllowed("inst-a", "inst-b"));
  });

  it("bindPathHintsServerInstance sets ams_bridge_server_instance_id", () => {
    const next = bindPathHintsServerInstance(
      { server_url: "smb://x/y", ams_bridge_server_instance_id: "" },
      "  inst-42  ",
    );
    assert.equal(next.ams_bridge_server_instance_id, "inst-42");
    const unchanged = bindPathHintsServerInstance(next, "  ");
    assert.equal(unchanged.ams_bridge_server_instance_id, "inst-42");
  });
});
