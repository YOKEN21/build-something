import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const SERVICE_CONFIG_PATH = /^services\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/config\.json$/;
const TASK_ROLE_PATH = /^iam\/[a-z0-9]+(?:-[a-z0-9]+)*-task-roles\.json$/;

/** Explicit opt-in for the structural catalog-path check. A missing plan list is not this mode. */
export const STRUCTURAL_ONLY_FLAG = "--structural-only";

export function missingPlanPathListMessage(): string {
  return [
    "No approved plan path list was supplied.",
    "Pass --allowed and --changed to compare a change with a plan.",
    `Pass ${STRUCTURAL_ONLY_FLAG} to run the structural catalog-path check.`,
    "A missing list is not a plan approval.",
  ].join(" ");
}

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Compare changed files with the concrete paths a plan allows.
 * An empty allow-list does not allow every file.
 */
export function filesOutsideAllowedPaths(
  changedFiles: readonly string[],
  allowedPaths: readonly string[],
): string[] {
  const allowed = new Set(allowedPaths.map(toPosix));
  return changedFiles.map(toPosix).filter((file) => !allowed.has(file));
}

export function listFiles(dir: string): string[] {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dir);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Structural check for synthetic files already in the tree.
 * This does not record a plan approval.
 */
export function catalogPathProblems(repoRelativePaths: readonly string[]): string[] {
  const problems: string[] = [];
  let serviceConfigs = 0;
  let taskRoleFiles = 0;
  for (const relativePath of repoRelativePaths.map(toPosix)) {
    if (relativePath.startsWith("services/")) {
      if (SERVICE_CONFIG_PATH.test(relativePath)) {
        serviceConfigs += 1;
      } else {
        problems.push(`${relativePath} is outside services/<product>/<service>/config.json`);
      }
    }
    if (relativePath.startsWith("iam/")) {
      if (TASK_ROLE_PATH.test(relativePath)) {
        taskRoleFiles += 1;
      } else {
        problems.push(`${relativePath} is outside iam/<product>-task-roles.json`);
      }
    }
  }
  if (serviceConfigs === 0) {
    problems.push("no service config found at services/<product>/<service>/config.json");
  }
  if (taskRoleFiles === 0) {
    problems.push("no task role file found at iam/<product>-task-roles.json");
  }
  return problems;
}
