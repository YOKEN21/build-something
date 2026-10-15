import { readdirSync } from "node:fs";
import path from "node:path";
import { releaseRuleProblems } from "../src/checks/rules";
import { listFiles } from "../src/checks/scope";
import { assertSchemaCompiles, readJson, validateInstance } from "../src/checks/schema";

const repoRoot = path.resolve(__dirname, "..");

type InstanceGroup = {
  label: string;
  schemaPath: string;
  files: string[];
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function serviceConfigs(): string[] {
  return listFiles(path.join(repoRoot, "services"))
    .map((file) => path.relative(repoRoot, file))
    .filter((file) => file.endsWith(`${path.sep}config.json`) || file.endsWith("/config.json"));
}

function taskRoleFiles(): string[] {
  const iamDir = path.join(repoRoot, "iam");
  return readdirSync(iamDir)
    .filter((name) => name.endsWith("-task-roles.json"))
    .map((name) => path.join("iam", name));
}

function loadSchema(relativePath: string): object {
  const schema = readJson(path.join(repoRoot, relativePath));
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    fail(`${relativePath} is not a JSON schema object`);
  }
  return schema;
}

const groups: InstanceGroup[] = [
  {
    label: "service config",
    schemaPath: "contracts/service-config.schema.json",
    files: serviceConfigs(),
  },
  {
    label: "task roles",
    schemaPath: "contracts/task-roles.schema.json",
    files: taskRoleFiles(),
  },
  {
    label: "release rules",
    schemaPath: "contracts/release-rules.schema.json",
    files: ["policy/release-rules.json"],
  },
];

const contractSchemas = [
  "contracts/change-request.schema.json",
  "contracts/risk-report.schema.json",
  "contracts/service-config.schema.json",
  "contracts/task-roles.schema.json",
  "contracts/release-rules.schema.json",
];

let checked = 0;

for (const schemaPath of contractSchemas) {
  const schema = loadSchema(schemaPath);
  try {
    assertSchemaCompiles(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${schemaPath} is not a usable schema: ${message}`);
  }
  console.log(`schema compiled: ${schemaPath}`);
}

for (const group of groups) {
  if (group.files.length === 0) {
    fail(`no synthetic JSON files found for ${group.label}`);
  }
  const schema = loadSchema(group.schemaPath);
  for (const relativePath of group.files) {
    const data = readJson(path.join(repoRoot, relativePath));
    const result = validateInstance(schema, data);
    if (!result.ok) {
      fail(`${relativePath} failed ${group.label} schema:\n${result.errors.join("\n")}`);
    }
    if (relativePath === "policy/release-rules.json") {
      const rules = (data as { rules?: { id?: string; rule?: string; effect?: string }[] }).rules;
      if (!Array.isArray(rules)) {
        fail("policy/release-rules.json is missing a rules array");
      }
      const problems = releaseRuleProblems(rules);
      if (problems.length > 0) {
        fail(`policy/release-rules.json does not match Section 7:\n${problems.join("\n")}`);
      }
    }
    checked += 1;
    console.log(`schema valid: ${relativePath}`);
  }
}

if (checked === 0) {
  fail("no synthetic JSON files were validated");
}

console.log(`validated ${checked} synthetic JSON file(s)`);
