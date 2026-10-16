import { parseApprovalRevision } from "./findings";
import type { ApprovalInput, AssessmentInput, ChangeType, CheckConclusion, ChecksInput, DiffFile, PlanInput } from "./types";

export type GitHubResponse = {
  status: number;
  body: unknown;
  linkNext: boolean;
};

export type GitHubClient = {
  get(path: string): Promise<GitHubResponse>;
};

export type CollectOptions = {
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  assessorSha: string;
  trustedApprover: string;
  catalogMarkdown: string;
  policy: unknown;
};

const CHANGE_TYPES = new Set<ChangeType>(["new-service", "config-change", "iam-permission-change"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function linkedIssueNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:^|\s)#(\d+)\b/g)) {
    found.add(Number(match[1]));
  }
  for (const match of text.matchAll(/issue:\s*(\d+)/gi)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

export function parsePlanComment(body: string, author: string): PlanInput | undefined {
  if (author.trim().length === 0) {
    return undefined;
  }
  const fields = new Map<string, string>();
  let headingRevision: number | undefined;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.trim().match(/^#{1,6}\s+plan revision\s+([1-9][0-9]*)\s*$/i);
    if (heading?.[1]) {
      headingRevision = Number(heading[1]);
      continue;
    }
    const field = line.match(/^\s*([A-Za-z][A-Za-z ]*):\s*(.+?)\s*$/);
    if (!field?.[1] || !field[2]) {
      continue;
    }
    fields.set(field[1].trim().toLowerCase(), field[2].trim());
  }
  const summary = fields.get("request summary");
  const changeType = fields.get("change type");
  const product = fields.get("product");
  const service = fields.get("service");
  const environment = fields.get("environment");
  const allowed = fields.get("allowed paths");
  const acceptance = fields.get("acceptance expectation");
  const issueText = fields.get("issue");
  const revisionText = fields.get("revision");
  const revision = revisionText !== undefined ? Number(revisionText) : headingRevision;
  const issue = issueText !== undefined ? Number(issueText) : undefined;
  if (
    summary === undefined ||
    changeType === undefined ||
    !CHANGE_TYPES.has(changeType as ChangeType) ||
    product === undefined ||
    service === undefined ||
    (environment !== "dev" && environment !== "prod") ||
    allowed === undefined ||
    acceptance === undefined ||
    issue === undefined ||
    !Number.isInteger(issue) ||
    issue < 1 ||
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    return undefined;
  }
  const allowedPaths = allowed.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (allowedPaths.length === 0) {
    return undefined;
  }
  return {
    issue,
    revision,
    change_type: changeType as ChangeType,
    summary,
    product,
    service,
    environment,
    allowed_paths: allowedPaths,
    acceptance_expectation: acceptance,
    author,
  };
}

export function selectPlan(comments: readonly { body: string; author: string }[]): { ok: true; plan: PlanInput } | { ok: false; reason: string } {
  const plans = comments
    .map((comment) => parsePlanComment(comment.body, comment.author))
    .filter((plan): plan is PlanInput => plan !== undefined);
  if (plans.length === 0) {
    return { ok: false, reason: "plan comment is missing" };
  }
  const highest = Math.max(...plans.map((plan) => plan.revision));
  const chosen = plans.filter((plan) => plan.revision === highest);
  if (chosen.length !== 1) {
    return { ok: false, reason: "more than one plan comment matches the highest revision" };
  }
  const plan = chosen[0];
  if (!plan) {
    return { ok: false, reason: "plan comment is missing" };
  }
  return { ok: true, plan };
}

export function selectApproval(
  comments: readonly { body: string; author: string; source?: number }[],
  revision: number,
  trustedApprover: string,
  authoritativeIssue?: number,
): ApprovalInput | null {
  if (trustedApprover.trim().length === 0) {
    return null;
  }
  const matches = comments.filter((comment) => {
    if (comment.author !== trustedApprover || parseApprovalRevision(comment.body) !== revision) {
      return false;
    }
    if (authoritativeIssue !== undefined && comment.source !== authoritativeIssue) {
      return false;
    }
    return true;
  });
  if (authoritativeIssue !== undefined && matches.length !== 1) {
    return null;
  }
  const match = matches[0];
  if (!match) {
    return null;
  }
  return {
    author: match.author,
    body: match.body.trim(),
    trusted_approver: trustedApprover,
    ...(match.source !== undefined ? { source_issue: match.source } : {}),
  };
}

function mapConclusion(conclusion: unknown, status: unknown): CheckConclusion {
  if (conclusion === "success") {
    return "success";
  }
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled" || conclusion === "action_required") {
    return "failure";
  }
  if (conclusion === null || status === "queued" || status === "in_progress" || status === "pending" || status === "waiting") {
    return "pending";
  }
  return "unknown";
}

export function mapCheckRuns(payload: unknown, headSha: string): ChecksInput {
  const runs = isRecord(payload) && Array.isArray(payload.check_runs) ? payload.check_runs : [];
  const required = runs.filter((run) => isRecord(run) && run.name === "secret-free checks").map((run) => {
    const record = run as Record<string, unknown>;
    return {
      name: "secret-free checks",
      conclusion: mapConclusion(record.conclusion, record.status),
    };
  });
  return { head_sha: headSha, required };
}

function decodeContent(body: unknown): string | null {
  if (!isRecord(body) || body.encoding !== "base64" || typeof body.content !== "string") {
    return null;
  }
  return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function commentsFrom(body: unknown, source: number): { body: string; author: string; source: number }[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const comments: { body: string; author: string; source: number }[] = [];
  for (const item of body) {
    if (!isRecord(item) || typeof item.body !== "string" || !isRecord(item.user) || typeof item.user.login !== "string") {
      continue;
    }
    comments.push({ body: item.body, author: item.user.login, source });
  }
  return comments;
}

function repoPath(owner: string, repo: string, rest: string): string {
  return `/repos/${owner}/${repo}${rest}`;
}

async function readFile(client: GitHubClient, owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
  const encoded = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const response = await client.get(`${repoPath(owner, repo, `/contents/${encoded}`)}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200 || response.linkNext) {
    throw new Error("GitHub contents read failed");
  }
  return decodeContent(response.body);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function preApprovalComment(input: AssessmentInput, maxAttempts: number): string {
  const files = input.diff?.files.map((file) => file.path) ?? [];
  const revision = input.plan === null ? "missing" : String(input.plan.revision);
  return [
    "## Assessment inputs",
    "",
    "Secret-free preparation recorded these inputs before the key-bearing job.",
    "This comment is not an assessment result and not a merge authorization.",
    "",
    `- Pull request: ${input.pr}`,
    `- Candidate head: ${input.head_sha}`,
    `- Base: ${input.base_sha}`,
    `- Assessor commit: ${input.assessor_sha}`,
    `- Plan revision: ${revision}`,
    `- Changed files: ${files.length > 0 ? files.join(", ") : "(none)"}`,
    `- Maximum API attempts: ${maxAttempts}`,
    "",
    "If the head, plan, or approval changes, this record is stale and the run must collect inputs again.",
    "",
  ].join("\n");
}

async function loadComments(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  prBody: string,
): Promise<{ ok: true; comments: { body: string; author: string; source: number }[] } | { ok: false; problems: string[] }> {
  const sources = [prNumber, ...linkedIssueNumbers(prBody).filter((issueNumber) => issueNumber !== prNumber)];
  const comments: { body: string; author: string; source: number }[] = [];
  for (const source of sources) {
    const response = await client.get(repoPath(owner, repo, `/issues/${source}/comments?per_page=100`));
    if (response.status !== 200 || response.linkNext) {
      return { ok: false, problems: ["plan comments could not be read in one page"] };
    }
    comments.push(...commentsFrom(response.body, source));
  }
  return { ok: true, comments };
}

export async function recheckPullRequest(
  client: GitHubClient,
  options: {
    owner: string;
    repo: string;
    prNumber: number;
    expectedHeadSha: string;
    preserved?: { plan: PlanInput | null; approval: ApprovalInput | null; trustedApprover: string };
  },
): Promise<{ ok: true; headSha: string } | { ok: false; problems: string[]; headSha?: string }> {
  const response = await client.get(repoPath(options.owner, options.repo, `/pulls/${options.prNumber}`));
  if (response.status !== 200 || !isRecord(response.body)) {
    return { ok: false, problems: ["pull request metadata could not be read"] };
  }
  const head = isRecord(response.body.head) ? response.body.head : undefined;
  const base = isRecord(response.body.base) ? response.body.base : undefined;
  const headSha = head ? asString(head.sha) : undefined;
  const baseRef = base ? asString(base.ref) : undefined;
  const headRepo = head && isRecord(head.repo) ? head.repo : undefined;
  const baseRepo = base && isRecord(base.repo) ? base.repo : undefined;
  const problems: string[] = [];
  if (headSha !== options.expectedHeadSha) {
    problems.push("pull request head does not match the expected SHA");
  }
  if (baseRef !== "main") {
    problems.push("pull request does not target main");
  }
  const fork = headRepo === undefined || headRepo.fork === true || asString(headRepo?.full_name) !== asString(baseRepo?.full_name);
  if (fork) {
    problems.push("pull request is from a fork");
  }
  if (options.preserved) {
    const loaded = await loadComments(client, options.owner, options.repo, options.prNumber, asString(response.body.body) ?? "");
    if (!loaded.ok) {
      problems.push(...loaded.problems);
    } else {
      const planResult = selectPlan(loaded.comments);
      const plan = planResult.ok ? planResult.plan : null;
      const approval = plan
        ? selectApproval(loaded.comments, plan.revision, options.preserved.trustedApprover, plan.issue)
        : null;
      if (!sameValue(plan, options.preserved.plan) || !sameValue(approval, options.preserved.approval)) {
        problems.push("plan or approval no longer matches the preserved inputs");
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, problems, headSha };
  }
  return { ok: true, headSha: options.expectedHeadSha };
}

export async function collectPullRequest(client: GitHubClient, options: CollectOptions): Promise<
  { ok: true; input: AssessmentInput } | { ok: false; problems: string[] }
> {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.repo)) {
    return { ok: false, problems: ["repository name is invalid"] };
  }
  if (!Number.isInteger(options.prNumber) || options.prNumber < 1) {
    return { ok: false, problems: ["pr_number must be a positive integer"] };
  }
  if (!/^[0-9a-f]{40}$/.test(options.expectedHeadSha) || !/^[0-9a-f]{40}$/.test(options.assessorSha)) {
    return { ok: false, problems: ["expected head SHA and assessor SHA must be 40 hexadecimal characters"] };
  }
  const verified = await recheckPullRequest(client, {
    owner: options.owner,
    repo: options.repo,
    prNumber: options.prNumber,
    expectedHeadSha: options.expectedHeadSha,
  });
  if (!verified.ok) {
    return { ok: false, problems: verified.problems };
  }
  const pull = await client.get(repoPath(options.owner, options.repo, `/pulls/${options.prNumber}`));
  if (!isRecord(pull.body) || pull.linkNext) {
    return { ok: false, problems: ["pull request metadata could not be read"] };
  }
  const baseSha = isRecord(pull.body.base) ? asString(pull.body.base.sha) : undefined;
  if (baseSha === undefined || !/^[0-9a-f]{40}$/.test(baseSha)) {
    return { ok: false, problems: ["pull request base SHA is missing"] };
  }
  const prBody = asString(pull.body.body) ?? "";
  const filesResponse = await client.get(repoPath(options.owner, options.repo, `/pulls/${options.prNumber}/files?per_page=100`));
  if (filesResponse.status !== 200 || !Array.isArray(filesResponse.body) || filesResponse.linkNext) {
    return { ok: false, problems: ["pull request diff could not be read in one page"] };
  }
  const files: DiffFile[] = [];
  for (const entry of filesResponse.body) {
    if (!isRecord(entry) || typeof entry.filename !== "string") {
      return { ok: false, problems: ["pull request file list cannot be parsed"] };
    }
    const status = asString(entry.status) ?? "modified";
    const before = status === "added" ? null : await readFile(client, options.owner, options.repo, entry.filename, baseSha);
    const after = status === "removed" ? null : await readFile(client, options.owner, options.repo, entry.filename, options.expectedHeadSha);
    files.push({
      path: entry.filename,
      patch: typeof entry.patch === "string" ? `diff --git a/${entry.filename} b/${entry.filename}\n${entry.patch}` : `diff --git a/${entry.filename} b/${entry.filename}`,
      before,
      after,
    });
  }
  const checksResponse = await client.get(
    repoPath(options.owner, options.repo, `/commits/${options.expectedHeadSha}/check-runs?per_page=100`),
  );
  if (checksResponse.status !== 200 || checksResponse.linkNext) {
    return { ok: false, problems: ["check runs for the head SHA could not be read in one page"] };
  }
  const loaded = await loadComments(client, options.owner, options.repo, options.prNumber, prBody);
  if (!loaded.ok) {
    return { ok: false, problems: loaded.problems };
  }
  const comments = loaded.comments;
  const planResult = selectPlan(comments);
  const plan = planResult.ok ? planResult.plan : null;
  const approval = plan ? selectApproval(comments, plan.revision, options.trustedApprover, plan.issue) : null;
  const input: AssessmentInput = {
    issue: plan?.issue ?? 0,
    pr: options.prNumber,
    head_sha: options.expectedHeadSha,
    base_sha: baseSha,
    assessor_sha: options.assessorSha,
    current_head_sha: options.expectedHeadSha,
    plan,
    approval,
    diff: { files },
    catalog_markdown: options.catalogMarkdown,
    checks: mapCheckRuns(checksResponse.body, options.expectedHeadSha),
    policy: options.policy,
    untrusted_pr_body: prBody.length > 0 ? prBody : null,
    trusted_approver: options.trustedApprover,
    inputs_match: true,
  };
  if (!planResult.ok) {
    input.issue = 0;
  }
  return { ok: true, input };
}
