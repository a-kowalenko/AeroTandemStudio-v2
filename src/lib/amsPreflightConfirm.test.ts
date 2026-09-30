import { describe, expect, it } from "vitest";
import { isAmsPreflightNotFoundError } from "./amsPreflightConfirm";

describe("isAmsPreflightNotFoundError", () => {
  it("detects the machine-readable prefix", () => {
    expect(
      isAmsPreflightNotFoundError(
        "AMS_PREFLIGHT_NOT_FOUND: not_found: Kunde nicht gefunden",
      ),
    ).toBe(true);
  });

  it("ignores unrelated AMS errors", () => {
    expect(
      isAmsPreflightNotFoundError("AMS-Bridge Lookup nicht erreichbar: timeout"),
    ).toBe(false);
    expect(isAmsPreflightNotFoundError("AMS Preflight: upstream_unavailable")).toBe(
      false,
    );
  });
});
