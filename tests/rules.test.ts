import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EXPECTED_RULES } from "../src/checks/rules";
import { readJson } from "../src/checks/schema";

const planEffects: Record<string, string> = {
  "IAM-01": "medium; missing owner or authorization evidence requires HUMAN",
  "IAM-02": "high, blocking",
  "IAM-03": "high, blocking",
  "IAM-04": "high, blocking",
  "ENV-01": "high",
  "NET-01": "high, blocking",
  "SCOPE-01": "blocking → NO-GO; correct the change or obtain approval for a revised plan",
  "SELF-01": "blocking → NO-GO; correct the change or obtain approval for a revised plan",
  "SIZE-01": "medium",
  "CHECK-01": "blocking",
};

test("release rules match the Section 7 ids and effects", () => {
  const file = readJson(path.join(__dirname, "..", "policy/release-rules.json")) as {
    rules: { id: string; rule: string; effect: string }[];
  };
  assert.deepEqual(
    file.rules.map((rule) => rule.id),
    Object.keys(planEffects),
  );
  for (const rule of file.rules) {
    assert.equal(rule.effect, planEffects[rule.id]);
  }
  assert.deepEqual(file.rules, EXPECTED_RULES);
  assert.equal(new Set(file.rules.map((rule) => rule.id)).size, 10);
});
