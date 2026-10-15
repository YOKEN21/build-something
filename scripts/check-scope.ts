import path from "node:path";
import { catalogPathProblems, filesOutsideAllowedPaths, listFiles, toPosix } from "../src/checks/scope";

const repoRoot = path.resolve(__dirname, "..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const allowedArg = argValue("--allowed");
const changedArg = argValue("--changed");

if (allowedArg !== undefined || changedArg !== undefined) {
  if (allowedArg === undefined || changedArg === undefined) {
    fail("scope check needs both --allowed and --changed. An empty list is not implied.");
  }
  const allowed = allowedArg.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const changed = changedArg.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const outside = filesOutsideAllowedPaths(changed, allowed);
  if (outside.length > 0) {
    fail(`files outside the allowed paths:\n${outside.join("\n")}`);
  }
  console.log("changed files are inside the allowed paths supplied to this command");
  process.exit(0);
}

const syntheticFiles = [
  ...listFiles(path.join(repoRoot, "services")),
  ...listFiles(path.join(repoRoot, "iam")),
].map((file) => toPosix(path.relative(repoRoot, file)));

const problems = catalogPathProblems(syntheticFiles);
if (problems.length > 0) {
  fail(problems.join("\n"));
}

console.log("No approved plan path list was supplied.");
console.log("Structural catalog-path check of synthetic files only.");
console.log("This result is not a plan approval and is not an assessment result.");
console.log(`structural catalog paths ok for ${syntheticFiles.length} synthetic file(s)`);
