import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readJson, validateInstance } from "../src/checks/schema";

const schema = readJson(path.join(__dirname, "..", "contracts/change-request.schema.json")) as object;

function requestFixture(): Record<string, unknown> {
  return {
    issue: 1,
    change_type: "config-change",
    summary: "Raise matter-search CPU within the preferred maximum.",
    product: "matter",
    service: "matter-search",
    environment: "dev",
    allowed_paths: ["services/matter/matter-search/config.json"],
    plan_revision: 1,
    acceptance_expectation: "Schema-valid config with a valid CPU and memory pair.",
  };
}

test("rejects a change request with an extra field", () => {
  const valid = validateInstance(schema, requestFixture());
  assert.equal(valid.ok, true, valid.errors.join("\n"));

  const extra = requestFixture();
  extra.approved = true;
  const result = validateInstance(schema, extra);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /additional propert/i);
});
