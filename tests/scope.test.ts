import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { catalogPathProblems, filesOutsideAllowedPaths } from "../src/checks/scope";

test("rejects a file outside the allowed paths", () => {
  const allowed = ["services/matter/matter-search/config.json"];
  const changed = [
    "services/matter/matter-search/config.json",
    "iam/matter-task-roles.json",
  ];
  assert.deepEqual(filesOutsideAllowedPaths(changed, allowed), ["iam/matter-task-roles.json"]);
  assert.deepEqual(filesOutsideAllowedPaths(["services/matter/matter-search/config.json"], allowed), []);
});

test("does not treat an empty allow-list as permission for every file", () => {
  assert.deepEqual(filesOutsideAllowedPaths(["README.md"], []), ["README.md"]);
});

test("check-scope rejects a file outside the allowed paths", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const rejected = spawnSync(
    tsx,
    [
      "scripts/check-scope.ts",
      "--allowed",
      "services/matter/matter-search/config.json",
      "--changed",
      "services/matter/matter-search/config.json,README.md",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`, /README\.md/);

  const accepted = spawnSync(
    tsx,
    [
      "scripts/check-scope.ts",
      "--allowed",
      "services/matter/matter-search/config.json",
      "--changed",
      "services/matter/matter-search/config.json",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(accepted.status, 0);
});

test("check-scope without a plan path list exits non-zero", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const missing = spawnSync(tsx, ["scripts/check-scope.ts"], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout ?? ""}\n${missing.stderr ?? ""}`, /No approved plan path list was supplied/);

  const mixed = spawnSync(tsx, ["scripts/check-scope.ts", "--structural-only", "--allowed", "README.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(mixed.status, 0);
});

test("structural catalog check runs only with the explicit flag", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const structural = spawnSync(tsx, ["scripts/check-scope.ts", "--structural-only"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const output = `${structural.stdout ?? ""}\n${structural.stderr ?? ""}`;
  assert.equal(structural.status, 0);
  assert.match(output, /Structural catalog-path check only/);
  assert.match(output, /not a plan approval/);
});

test("rejects a synthetic file outside the catalog paths", () => {
  const problems = catalogPathProblems([
    "services/matter/matter-search/extra.json",
    "iam/matter-task-roles.json",
  ]);
  assert.ok(problems.some((problem) => problem.includes("services/matter/matter-search/extra.json")));

  const baseline = catalogPathProblems([
    "services/matter/matter-search/config.json",
    "iam/matter-task-roles.json",
  ]);
  assert.deepEqual(baseline, []);
});
