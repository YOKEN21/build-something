import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "..");

test("matter-search baseline stays on the synthetic dev account", () => {
  const config = JSON.parse(
    readFileSync(path.join(repoRoot, "services/matter/matter-search/config.json"), "utf8"),
  ) as { account: string; environment: string; service: string; publicEndpoint: boolean };
  const roles = JSON.parse(readFileSync(path.join(repoRoot, "iam/matter-task-roles.json"), "utf8")) as {
    account: string;
    roles: { name: string; service: string; environment: string; statements: unknown[] }[];
  };
  const roleText = readFileSync(path.join(repoRoot, "iam/matter-task-roles.json"), "utf8");

  assert.equal(config.account, "111111111111");
  assert.equal(config.environment, "dev");
  assert.equal(config.service, "matter-search");
  assert.equal(config.publicEndpoint, false);
  assert.equal(roles.account, "111111111111");
  assert.equal(roles.roles.length, 1);
  assert.equal(roles.roles[0]?.name, "matter-search");
  assert.equal(roles.roles[0]?.service, "matter-search");
  assert.equal(roles.roles[0]?.environment, "dev");
  assert.deepEqual(roles.roles[0]?.statements, []);
  assert.equal(roleText.includes("example-documents-dev"), false);
  assert.equal(roleText.includes("iam:"), false);
  assert.equal(roleText.includes("kms:"), false);
  assert.equal(roleText.includes("sts:"), false);
});
