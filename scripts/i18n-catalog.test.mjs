import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function catalogKeysFromSource() {
  const src = readFileSync(join(root, "scripts", "generate-i18n-locales.mjs"), "utf8");
  const start = src.indexOf("const catalog = {");
  const end = src.indexOf("\nfunction setNested");
  assert.ok(start >= 0 && end > start, "catalog block not found");
  const block = src.slice(start, end);
  return [...block.matchAll(/^  "([^"]+)": \{/gm)].map((m) => m[1]);
}

function flatten(obj, prefix = "", out = {}) {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out[prefix] = obj;
  return out;
}

function prefixCollision(keys) {
  const set = new Set(keys);
  for (const key of keys) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(".");
      if (set.has(prefix)) return { leaf: prefix, nested: key };
    }
  }
  return null;
}

describe("i18n catalog", () => {
  const catalogKeys = catalogKeysFromSource();
  const de = flatten(
    JSON.parse(readFileSync(join(root, "src", "locales", "de.json"), "utf8")),
  );
  const en = flatten(
    JSON.parse(readFileSync(join(root, "src", "locales", "en.json"), "utf8")),
  );
  const es = flatten(
    JSON.parse(readFileSync(join(root, "src", "locales", "es-MX.json"), "utf8")),
  );

  it("has unique keys and no leaf/nest prefix collisions", () => {
    const unique = new Set(catalogKeys);
    assert.equal(
      catalogKeys.length,
      unique.size,
      "duplicate keys in generate-i18n-locales.mjs catalog",
    );
    assert.equal(prefixCollision(catalogKeys), null);
  });

  it("locale JSON key sets match the catalog and each other", () => {
    const catalog = new Set(catalogKeys);
    const deKeys = Object.keys(de);
    const enKeys = Object.keys(en);
    const esKeys = Object.keys(es);
    const missingInJson = catalogKeys.filter((k) => !(k in de));
    const extraInJson = deKeys.filter((k) => !catalog.has(k));
    assert.deepEqual(missingInJson, [], "de.json missing catalog keys");
    assert.deepEqual(extraInJson, [], "de.json has keys not in catalog");
    assert.deepEqual(enKeys.sort(), deKeys.slice().sort());
    assert.deepEqual(esKeys.sort(), deKeys.slice().sort());
  });
});
