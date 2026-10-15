import path from "node:path";
import { cpuMemoryError, exceedsPreferredSize } from "../src/checks/cpu-memory";
import { readJson } from "../src/checks/schema";
import { listFiles } from "../src/checks/scope";

const repoRoot = path.resolve(__dirname, "..");

type ServiceConfig = {
  service?: string;
  cpu?: unknown;
  memory?: unknown;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const configs = listFiles(path.join(repoRoot, "services")).filter((file) => file.endsWith("config.json"));

if (configs.length === 0) {
  fail("no service config files found for the CPU/memory check");
}

for (const file of configs) {
  const relativePath = path.relative(repoRoot, file);
  const config = readJson(file) as ServiceConfig;
  if (typeof config.cpu !== "number" || typeof config.memory !== "number") {
    fail(`${relativePath} is missing numeric cpu and memory`);
  }
  const error = cpuMemoryError(config.cpu, config.memory);
  if (error !== undefined) {
    fail(`${relativePath}: ${error}`);
  }
  const size = exceedsPreferredSize(config.cpu, config.memory)
    ? "above the preferred catalog maximum"
    : "within the preferred catalog maximum";
  console.log(`${relativePath}: valid CPU/memory combination, ${size}`);
}
