import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bumpCore,
  compareSemVer,
  isPrereleaseVersion,
  nextBetaLineVersion,
  nextBetaVersion,
  toStableVersion,
} from "./semver.mjs";
import {
  insertBetaSnapshot,
  insertVersionNotes,
  resolveNotesForRelease,
} from "./changelog.mjs";

describe("semver", () => {
  it("orders prerelease below release", () => {
    assert.ok(compareSemVer("0.3.9-beta.1", "0.3.9") < 0);
    assert.ok(compareSemVer("0.3.9", "0.3.9-beta.1") > 0);
    assert.ok(compareSemVer("0.3.9-beta.1", "0.3.9-beta.2") < 0);
    assert.equal(compareSemVer("v0.3.9-beta.1", "0.3.9-beta.1"), 0);
  });

  it("bumps beta and promotes to stable", () => {
    assert.equal(nextBetaVersion("0.3.8", "patch"), "0.3.9-beta.1");
    assert.equal(nextBetaVersion("0.3.9-beta.1"), "0.3.9-beta.2");
    assert.equal(toStableVersion("0.3.9-beta.2"), "0.3.9");
    assert.equal(bumpCore("0.3.8", "patch"), "0.3.9");
    assert.ok(isPrereleaseVersion("0.3.9-beta.1"));
    assert.ok(!isPrereleaseVersion("0.3.9"));
  });

  it("starts new beta line from prerelease", () => {
    assert.equal(nextBetaLineVersion("0.3.9-beta.2", "patch"), "0.3.10-beta.1");
    assert.equal(nextBetaLineVersion("0.3.9-beta.2", "minor"), "0.4.0-beta.1");
    assert.equal(nextBetaLineVersion("0.3.9-beta.2", "major"), "1.0.0-beta.1");
    assert.ok(compareSemVer("0.3.9-beta.2", "0.4.0-beta.1") < 0);
  });
});

describe("changelog beta/stable", () => {
  const base = `## [Unreleased]

### Neu
- Feature A

## [0.3.8] - 2026-08-01

### Behoben
- Fix B
`;

  it("snapshots beta without clearing Unreleased", () => {
    const next = insertBetaSnapshot(base, "0.3.9-beta.1", "### Neu\n- Feature A");
    assert.match(next, /## \[Unreleased\]\s*\n\s*### Neu\s*\n- Feature A/);
    assert.match(next, /## \[0\.3\.9-beta\.1\]/);
  });

  it("promotes stable and clears Unreleased", () => {
    const next = insertVersionNotes(base, "0.3.9", "### Neu\n- Feature A");
    assert.match(next, /## \[Unreleased\]\s*\n\s*## \[0\.3\.9\]/);
    assert.doesNotMatch(
      next,
      /## \[Unreleased\][\s\S]*Feature A[\s\S]*## \[0\.3\.9\]/,
    );
  });

  it("uses stub when beta and Unreleased empty", () => {
    const empty = `## [Unreleased]\n\n## [0.3.8] - 2026-08-01\n\n- x\n`;
    const { source, body } = resolveNotesForRelease(empty, "patch", "0.3.8", "beta");
    assert.equal(source, "stub");
    assert.match(body, /Vorabversion/);
  });
});
