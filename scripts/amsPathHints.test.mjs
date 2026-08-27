import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AMS_BACKUP_PROFILE_ID,
  anyProfileMatchesPathHints,
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
  pruneWizardPresetsAfterPathApplyWire,
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
      active_server_profile_id: "default",
      server_profiles: [
        {
          id: "default",
          label: "x",
          url: DEFAULT_SERVER_URL,
          login: "",
          password: "",
          backup_url: "",
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
          {
            ...baseConfig.server_profiles[0],
            url: hints.primarySmbUrl,
            backup_url: hints.backupSmbUrl,
          },
        ],
      },
      hints,
    );
    assert.equal(match.kind, "match");
  });

  it("diff: no suggest when another profile already has AMS paths", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    assert.ok(
      anyProfileMatchesPathHints(
        [
          {
            id: "ams-live",
            url: hints.primarySmbUrl,
            backup_url: hints.backupSmbUrl,
          },
        ],
        hints,
      ),
    );
    const kind = computePathHintsDiff(
      {
        server_url: DEFAULT_SERVER_URL,
        active_server_profile_id: "new",
        server_profiles: [
          {
            id: "ams-live",
            url: hints.primarySmbUrl,
            backup_url: hints.backupSmbUrl,
          },
          {
            id: "new",
            url: DEFAULT_SERVER_URL,
            backup_url: "",
          },
        ],
      },
      hints,
    ).kind;
    assert.equal(kind, "match");
  });

  it("drift facets: primary only, backup only, both", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const primaryOnly = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        active_server_profile_id: "default",
        server_profiles: [
          {
            id: "default",
            url: "smb://other/share",
            backup_url: hints.backupSmbUrl,
          },
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
        active_server_profile_id: "default",
        server_profiles: [
          {
            id: "default",
            url: hints.primarySmbUrl,
            backup_url: "smb://x/old",
          },
        ],
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
        active_server_profile_id: "default",
        server_profiles: [
          {
            id: "default",
            url: "smb://other/share",
            backup_url: "smb://x/old",
          },
        ],
      },
      hints,
    );
    assert.deepEqual(pathHintsDriftFacets(both), {
      primary: true,
      backup: true,
    });
  });

  it("apply: creates new profile and keeps existing ones", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const config = {
      server_url: DEFAULT_SERVER_URL,
      active_server_profile_id: "default",
      server_login: "user",
      server_password: "pass",
      ams_bridge_display_name: "Video-PC Nord",
      server_profiles: [
        {
          id: "default",
          label: "Video-PC Calden",
          url: DEFAULT_SERVER_URL,
          login: "user",
          password: "pass",
          backup_url: "",
        },
        {
          id: "gera",
          label: "Video-PC Gera",
          url: "",
          login: "",
          password: "",
          backup_url: "",
        },
      ],
    };
    const applied = applyPathHintsToConfigWire(config, hints, "Video-PC Nord");
    assert.equal(applied.server_url, hints.primarySmbUrl);
    assert.ok(
      !applied.server_profiles.some((p) => p.id === AMS_BACKUP_PROFILE_ID),
    );
    assert.equal(applied.server_profiles.length, 3);
    assert.ok(applied.server_profiles.some((p) => p.id === "default"));
    assert.ok(applied.server_profiles.some((p) => p.id === "gera"));
    const active = applied.server_profiles.find(
      (p) => p.id === applied.active_server_profile_id,
    );
    assert.ok(active);
    assert.notEqual(active.id, "default");
    assert.notEqual(active.id, "gera");
    assert.equal(active.url, hints.primarySmbUrl);
    assert.equal(active.backup_url, hints.backupSmbUrl);
    assert.equal(active.label, "Video-PC Nord");
    // Original profiles untouched
    const calden = applied.server_profiles.find((p) => p.id === "default");
    assert.equal(calden.url, DEFAULT_SERVER_URL);
  });

  it("apply: activates existing matching profile instead of duplicating", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const config = {
      server_url: DEFAULT_SERVER_URL,
      active_server_profile_id: "default",
      server_profiles: [
        {
          id: "default",
          url: DEFAULT_SERVER_URL,
          backup_url: "",
        },
        {
          id: "ams-live",
          label: "AMS Live",
          url: hints.primarySmbUrl,
          backup_url: hints.backupSmbUrl,
          login: "u",
          password: "p",
        },
      ],
    };
    const applied = applyPathHintsToConfigWire(config, hints, "Video-PC Nord");
    assert.equal(applied.active_server_profile_id, "ams-live");
    assert.equal(applied.server_profiles.length, 2);
    assert.equal(applied.server_url, hints.primarySmbUrl);
    assert.equal(applied.server_login, "u");
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

  it("copy primary creds into active profile backup fields", () => {
    const next = copyPrimaryCredsToBackupProfileWire({
      server_login: "a",
      server_password: "b",
      active_server_profile_id: "default",
      server_profiles: [
        {
          id: "default",
          url: "smb://x/primary",
          backup_url: "smb://x/backup",
          backup_login: "",
          backup_password: "",
        },
      ],
    });
    const active = next.server_profiles.find((p) => p.id === "default");
    assert.equal(active.backup_login, "a");
    assert.equal(active.backup_password, "b");
  });

  it("drift signature and dismiss suppress until hints or config change", () => {
    const hints = {
      primarySmbUrl: "smb://10.0.0.5/aktuell",
      backupSmbUrl: "smb://10.0.0.5/backup",
    };
    const diff = computePathHintsDiff(
      {
        server_url: "smb://other/share",
        active_server_profile_id: "default",
        server_profiles: [
          { id: "default", url: "smb://other/share", backup_url: "smb://x/old" },
        ],
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
        active_server_profile_id: "default",
        server_profiles: [
          { id: "default", url: "smb://other/share", backup_url: "smb://x/old" },
        ],
      },
      newHints,
    );
    assert.ok(!shouldSuppressPathHintsDriftBanner(afterHintChange, dismiss));

    const afterUserEdit = computePathHintsDiff(
      {
        server_url: "smb://user-edited/share",
        active_server_profile_id: "default",
        server_profiles: [
          {
            id: "default",
            url: "smb://user-edited/share",
            backup_url: "smb://x/old",
          },
        ],
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

  it("pruneWizardPresetsAfterPathApply keeps active with backup_url, drops gera and legacy ams-backup", () => {
    const pruned = pruneWizardPresetsAfterPathApplyWire({
      server_url: "smb://10.0.0.5/aktuell",
      server_login: "u",
      server_password: "p",
      active_server_profile_id: "default",
      server_profiles: [
        {
          id: "default",
          label: "AMS Live",
          url: "smb://10.0.0.5/aktuell",
          login: "u",
          password: "p",
          backup_url: "smb://10.0.0.5/backup",
        },
        {
          id: "gera",
          label: "Video-PC Gera",
          url: "",
          login: "",
          password: "",
        },
        {
          id: AMS_BACKUP_PROFILE_ID,
          label: "AMS Backup",
          url: "smb://10.0.0.5/backup",
          login: "u",
          password: "p",
        },
      ],
    });
    assert.deepEqual(
      pruned.server_profiles?.map((p) => p.id),
      ["default"],
    );
    assert.equal(pruned.server_profiles[0].backup_url, "smb://10.0.0.5/backup");
    assert.equal(pruned.active_server_profile_id, "default");
    assert.equal(pruned.server_url, "smb://10.0.0.5/aktuell");
  });
});
