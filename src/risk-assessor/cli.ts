import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { collectPullRequest, preApprovalComment, recheckPullRequest, type GitHubClient } from "./collect";
import { assess } from "./assess";
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, MAX_ATTEMPTS, grokProvider } from "./grok-client";
import type { AssessmentInput } from "./types";

function redactSecrets(message: string): string {
  let redacted = message;
  for (const name of ["XAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const secret = process.env[name];
    if (secret && secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

function fail(message: string): never {
  console.error(redactSecrets(message));
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    fail(`${name} is not set`);
  }
  return value.trim();
}

function integerEnv(name: string): number {
  const value = requireEnv(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(`${name} must be a positive integer`);
  }
  return Number(value);
}

function shaEnv(name: string): string {
  const value = requireEnv(name);
  if (!/^[0-9a-f]{40}$/.test(value)) {
    fail(`${name} must be 40 hexadecimal characters`);
  }
  return value;
}

function repository(): { owner: string; repo: string } {
  const value = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = value.split("/");
  if (!owner || !repo || value.split("/").length !== 2) {
    fail("GITHUB_REPOSITORY must be owner/repo");
  }
  return { owner, repo };
}

function githubClient(token: string): GitHubClient {
  return {
    async get(path: string) {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "build-something-risk-assessor",
        },
      });
      const link = response.headers.get("link") ?? "";
      const body: unknown = response.status === 204 ? null : await response.json();
      return { status: response.status, body, linkNext: link.includes('rel="next"') };
    },
  };
}

function readInput(file: string): AssessmentInput {
  return JSON.parse(readFileSync(file, "utf8")) as AssessmentInput;
}

async function collect(outputDir: string): Promise<void> {
  const { owner, repo } = repository();
  const token = requireEnv("GH_TOKEN");
  const catalogMarkdown = readFileSync("docs/service-catalog.md", "utf8");
  const policy: unknown = JSON.parse(readFileSync("policy/release-rules.json", "utf8"));
  const result = await collectPullRequest(githubClient(token), {
    owner,
    repo,
    prNumber: integerEnv("PR_NUMBER"),
    expectedHeadSha: shaEnv("EXPECTED_HEAD_SHA"),
    assessorSha: shaEnv("ASSESSOR_SHA"),
    trustedApprover: process.env.ASSESSMENT_APPROVER?.trim() ?? "",
    catalogMarkdown,
    policy,
  });
  if (!result.ok) {
    fail(result.problems.join("\n"));
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/input.json`, `${JSON.stringify(result.input, null, 2)}\n`);
  console.log("collected assessment inputs");
}

async function recheck(inputPath: string): Promise<void> {
  const { owner, repo } = repository();
  const token = requireEnv("GH_TOKEN");
  const input = readInput(inputPath);
  const result = await recheckPullRequest(githubClient(token), {
    owner,
    repo,
    prNumber: input.pr,
    expectedHeadSha: input.head_sha,
    preserved: {
      plan: input.plan,
      approval: input.approval,
      trustedApprover: input.trusted_approver,
    },
  });
  if (result.headSha) {
    input.current_head_sha = result.headSha;
  }
  input.inputs_match = result.ok;
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  if (!result.ok) {
    fail(result.problems.join("\n"));
  }
  console.log("pull request head, plan, and approval still match the preserved inputs");
}

async function runAssess(inputPath: string, outputPath: string, diagnosticsPath: string): Promise<void> {
  const input = readInput(inputPath);
  const model = process.env.XAI_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = process.env.XAI_TIMEOUT_MS ? Number(process.env.XAI_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const maxAttempts = process.env.XAI_MAX_ATTEMPTS ? Number(process.env.XAI_MAX_ATTEMPTS) : MAX_ATTEMPTS;
  const apiKey = process.env.XAI_API_KEY ?? "";
  const result = await assess(input, {
    provider: grokProvider({
      apiKey,
      maxAttempts: Number.isInteger(maxAttempts) ? maxAttempts : MAX_ATTEMPTS,
    }),
    model,
    secret: apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });
  writeFileSync(diagnosticsPath, `${JSON.stringify(result.diagnostics, null, 2)}\n`);
  if (result.report === null) {
    fail("no schema-valid risk report was written");
  }
  writeFileSync(outputPath, `${JSON.stringify(result.report, null, 2)}\n`);
  console.log(`decision: ${result.decision}`);
  console.log(`model: ${result.diagnostics.model}`);
  console.log(`prompt_version: ${result.diagnostics.prompt_version}`);
  console.log(`duration_ms: ${result.diagnostics.duration_ms}`);
  console.log(`attempts: ${result.diagnostics.attempts}`);
  if (result.diagnostics.token_usage) {
    console.log(`input_tokens: ${result.diagnostics.token_usage.input_tokens ?? "unknown"}`);
    console.log(`output_tokens: ${result.diagnostics.token_usage.output_tokens ?? "unknown"}`);
  }
}

function commentFile(reportPath: string, diagnosticsPath: string, outputPath: string): void {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    assessment_status?: string;
    risk?: string | null;
    blocking?: boolean;
    needs_human?: boolean;
    rules_hit?: string[];
    summary?: string;
    head_sha?: string;
    base_sha?: string;
    assessor_sha?: string;
    plan_revision?: number;
    model?: string;
    prompt_version?: string;
  };
  const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8")) as { decision?: string };
  const rules = report.rules_hit && report.rules_hit.length > 0 ? report.rules_hit.join(", ") : "(none)";
  const body = [
    "## Risk assessment",
    "",
    "This comment is generated from risk-report.json. It is not a merge authorization.",
    "",
    `- Decision: ${diagnostics.decision ?? "unavailable"}`,
    `- Assessment status: ${report.assessment_status ?? "unavailable"}`,
    `- Risk: ${report.risk === null || report.risk === undefined ? "null" : report.risk}`,
    `- Blocking: ${String(report.blocking)}`,
    `- Needs human: ${String(report.needs_human)}`,
    `- Rules: ${rules}`,
    `- Head: ${report.head_sha ?? "unavailable"}`,
    `- Base: ${report.base_sha ?? "unavailable"}`,
    `- Assessor: ${report.assessor_sha ?? "unavailable"}`,
    `- Plan revision: ${String(report.plan_revision ?? "unavailable")}`,
    `- Model: ${report.model ?? "unavailable"}`,
    `- Prompt version: ${report.prompt_version ?? "unavailable"}`,
    "",
    "Summary:",
    "",
    report.summary ?? "",
    "",
  ].join("\n");
  writeFileSync(outputPath, body);
  console.log("wrote the pull request comment file");
}

const command = process.argv[2];

if (command === "collect") {
  const outputDir = argValue("--output") ?? "assessment-inputs";
  collect(outputDir).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : "collect failed");
  });
} else if (command === "recheck") {
  const inputPath = argValue("--input") ?? "assessment-inputs/input.json";
  recheck(inputPath).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : "recheck failed");
  });
} else if (command === "assess") {
  const inputPath = argValue("--input");
  const outputPath = argValue("--output");
  const diagnosticsPath = argValue("--diagnostics");
  if (!inputPath || !outputPath || !diagnosticsPath) {
    fail("assess requires --input, --output, and --diagnostics");
  }
  runAssess(inputPath, outputPath, diagnosticsPath).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : "assess failed");
  });
} else if (command === "preamble") {
  const inputPath = argValue("--input");
  const outputPath = argValue("--output");
  if (!inputPath || !outputPath) {
    fail("preamble requires --input and --output");
  }
  writeFileSync(outputPath, preApprovalComment(readInput(inputPath), MAX_ATTEMPTS));
  console.log("wrote the pre-approval summary");
} else if (command === "comment-file") {
  const reportPath = argValue("--report");
  const diagnosticsPath = argValue("--diagnostics");
  const outputPath = argValue("--output");
  if (!reportPath || !diagnosticsPath || !outputPath) {
    fail("comment-file requires --report, --diagnostics, and --output");
  }
  commentFile(reportPath, diagnosticsPath, outputPath);
} else {
  fail("usage: cli.ts <collect|recheck|assess|preamble|comment-file>");
}
