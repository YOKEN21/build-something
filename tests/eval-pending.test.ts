import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("eval stays incomplete", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const result = spawnSync(path.join(repoRoot, "node_modules", ".bin", "tsx"), ["scripts/eval-pending.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(/\bpass\b/i.test(output), false);
  assert.match(output, /PENDING: live API evaluation has not been run/);
});
