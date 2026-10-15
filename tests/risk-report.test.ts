import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { unknownRuleIds } from "../src/checks/rules";
import { readJson, validateInstance } from "../src/checks/schema";

const repoRoot = path.resolve(__dirname, "..");
const schema = readJson(path.join(repoRoot, "contracts/risk-report.schema.json")) as object;

function shapeFixture(): Record<string, unknown> {
  return {
    issue: 1,
    pr: 1,
    head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    assessor_sha: "cccccccccccccccccccccccccccccccccccccccc",
    plan_revision: 1,
    assessment_status: "complete",
    risk: "low",
    blocking: false,
    needs_human: false,
    rules_hit: ["IAM-01"],
    evidence: [{ file: "iam/matter-task-roles.json", quote: "matter-search" }],
    scope_ok: true,
    summary: "Shape fixture only. This is not an assessment result.",
    model: "unspecified",
    prompt_version: "0",
  };
}

test("accepts a complete report shape and a null risk", () => {
  const complete = validateInstance(schema, shapeFixture());
  assert.equal(complete.ok, true, complete.errors.join("\n"));

  const incomplete = shapeFixture();
  incomplete.assessment_status = "incomplete";
  incomplete.risk = null;
  incomplete.needs_human = true;
  incomplete.rules_hit = [];
  incomplete.evidence = [];
  const result = validateInstance(schema, incomplete);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("rejects a report with a missing field", () => {
  const report = shapeFixture();
  delete report.head_sha;
  const result = validateInstance(schema, report);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /head_sha/);
});

test("rejects a report with an extra field", () => {
  const report = shapeFixture();
  report.approval = "APPROVED plan v1";
  const result = validateInstance(schema, report);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /additional propert/i);
});

test("rejects an unknown rule id", () => {
  const report = shapeFixture();
  report.rules_hit = ["NO-SUCH-RULE"];
  const result = validateInstance(schema, report);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /NO-SUCH-RULE|allowed values/);

  const policy = readJson(path.join(repoRoot, "policy/release-rules.json")) as {
    rules: { id: string }[];
  };
  const known = new Set(policy.rules.map((rule) => rule.id));
  assert.equal(known.has("NO-SUCH-RULE"), false);
  assert.deepEqual(unknownRuleIds(["IAM-01", "NO-SUCH-RULE"], known), ["NO-SUCH-RULE"]);
  assert.deepEqual(unknownRuleIds(["IAM-01"], known), []);
});
