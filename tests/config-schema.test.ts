import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readJson, validateInstance } from "../src/checks/schema";

const repoRoot = path.resolve(__dirname, "..");
const schema = readJson(path.join(repoRoot, "contracts/service-config.schema.json")) as object;
const baseline = readJson(path.join(repoRoot, "services/matter/matter-search/config.json"));

test("rejects a config that breaks the schema", () => {
  const valid = validateInstance(schema, baseline);
  assert.equal(valid.ok, true, valid.errors.join("\n"));

  const broken = { ...(baseline as Record<string, unknown>), region: "us-east-1" };
  const result = validateInstance(schema, broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /additional propert/i);
});

test("rejects a config that omits a required field", () => {
  const broken = { ...(baseline as Record<string, unknown>) };
  delete broken.cpu;
  const result = validateInstance(schema, broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cpu/);
});
