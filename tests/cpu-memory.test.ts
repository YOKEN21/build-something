import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cpuMemoryError, exceedsPreferredSize, isValidCpuMemory } from "../src/checks/cpu-memory";
import { readJson } from "../src/checks/schema";

test("rejects an invalid CPU/memory pair", () => {
  assert.equal(isValidCpuMemory(256, 4096), false);
  assert.match(cpuMemoryError(256, 4096) ?? "", /invalid CPU\/memory combination: cpu 256, memory 4096/);
  assert.equal(isValidCpuMemory(512, 1024), true);
  assert.equal(cpuMemoryError(512, 1024), undefined);
});

test("keeps a valid pair above the preferred maximum distinct from an invalid pair", () => {
  assert.equal(isValidCpuMemory(2048, 4096), true);
  assert.equal(exceedsPreferredSize(2048, 4096), true);
  assert.equal(exceedsPreferredSize(512, 1024), false);
  assert.equal(isValidCpuMemory(256, 4096), false);
});

test("accepts the matter-search baseline pair", () => {
  const config = readJson(path.join(__dirname, "..", "services/matter/matter-search/config.json")) as {
    cpu: number;
    memory: number;
  };
  assert.equal(cpuMemoryError(config.cpu, config.memory), undefined);
  assert.equal(exceedsPreferredSize(config.cpu, config.memory), false);
});
