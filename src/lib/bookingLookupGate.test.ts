/**
 * Phase 53 / T4 — Gate + path priority (TS mirror of Rust lookup_map / lookup_router).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookingLookupPath,
  canRunAmsIdLookup,
  clearCloudLookupConfigLocal,
  isAmsLookupLive,
  isCloudLookupAvailable,
  isCloudLookupTokenInvalid,
  isLookupUnreachable,
} from "./bookingLookupGate.ts";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function cloudConfig(over: {
  token?: string;
  expiresAt?: string;
  baseUrl?: string;
} = {}) {
  return {
    cloud_lookup_access_token: over.token ?? "eyJhbGciOi.test",
    cloud_lookup_expires_at:
      over.expiresAt ?? "2026-10-09T12:00:00.000Z",
    cloud_lookup_cloud_base_url: over.baseUrl ?? "https://cloud.example",
  };
}

describe("isCloudLookupAvailable", () => {
  it("requires token, base URL, and future expiry", () => {
    assert.equal(isCloudLookupAvailable(cloudConfig(), NOW), true);
    assert.equal(isCloudLookupAvailable(null, NOW), false);
    assert.equal(
      isCloudLookupAvailable(cloudConfig({ token: "  " }), NOW),
      false,
    );
    assert.equal(
      isCloudLookupAvailable(cloudConfig({ baseUrl: "" }), NOW),
      false,
    );
    assert.equal(
      isCloudLookupAvailable(
        cloudConfig({ expiresAt: "2026-10-07T11:59:59.000Z" }),
        NOW,
      ),
      false,
    );
    assert.equal(
      isCloudLookupAvailable(cloudConfig({ expiresAt: "not-a-date" }), NOW),
      false,
    );
  });
});

describe("isAmsLookupLive / canRunAmsIdLookup", () => {
  it("AMS live needs configured + connected + lookup cap (empty = legacy allow)", () => {
    assert.equal(
      isAmsLookupLive({ configured: true, connected: true, capabilities: [] }),
      true,
    );
    assert.equal(
      isAmsLookupLive({
        configured: true,
        connected: true,
        capabilities: ["lookup"],
      }),
      true,
    );
    assert.equal(
      isAmsLookupLive({
        configured: true,
        connected: true,
        capabilities: ["ready"],
      }),
      false,
    );
    assert.equal(
      isAmsLookupLive({
        configured: true,
        connected: false,
        capabilities: ["lookup"],
      }),
      false,
    );
  });

  it("gate opens for AMS live or usable Cloud JWT", () => {
    assert.equal(
      canRunAmsIdLookup({
        configured: true,
        connected: true,
        capabilities: ["lookup"],
      }),
      true,
    );
    assert.equal(
      canRunAmsIdLookup({
        configured: true,
        connected: false,
        capabilities: ["lookup"],
        cloudLookupAvailable: true,
      }),
      true,
    );
    assert.equal(
      canRunAmsIdLookup({
        configured: false,
        connected: false,
        cloudLookupAvailable: true,
      }),
      true,
    );
    assert.equal(
      canRunAmsIdLookup({
        configured: true,
        connected: false,
        capabilities: ["lookup"],
        cloudLookupAvailable: false,
      }),
      false,
    );
  });
});

describe("bookingLookupPath (router priority)", () => {
  it("prefers AMS over Cloud over Offline", () => {
    assert.equal(
      bookingLookupPath({ amsLive: true, cloudLookupAvailable: true }),
      "ams",
    );
    assert.equal(
      bookingLookupPath({ amsLive: true, cloudLookupAvailable: false }),
      "ams",
    );
    assert.equal(
      bookingLookupPath({ amsLive: false, cloudLookupAvailable: true }),
      "cloud",
    );
    assert.equal(
      bookingLookupPath({ amsLive: false, cloudLookupAvailable: false }),
      "offline",
    );
  });
});

describe("error helpers + token clear", () => {
  it("detects unreachable and Cloud 401 messages", () => {
    assert.equal(
      isLookupUnreachable("Buchungssuche nicht erreichbar."),
      true,
    );
    assert.equal(isLookupUnreachable("Kunde nicht gefunden"), false);
    assert.equal(
      isCloudLookupTokenInvalid("Cloud-Lookup: Token ungültig (401)."),
      true,
    );
    assert.equal(isCloudLookupTokenInvalid("token_invalid"), true);
    assert.equal(isCloudLookupTokenInvalid("not_found"), false);
  });

  it("clearCloudLookupConfigLocal wipes JWT fields", () => {
    let patch: Record<string, string> | null = null;
    clearCloudLookupConfigLocal((p) => {
      patch = p;
    });
    assert.deepEqual(patch, {
      cloud_lookup_access_token: "",
      cloud_lookup_expires_at: "",
      cloud_lookup_cloud_base_url: "",
      cloud_lookup_ams_server_instance_id: "",
    });
  });
});
