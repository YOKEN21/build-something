import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { linkedIssueNumbers, selectApproval, selectPlan, type GitHubClient, type GitHubResponse } from "./collect";

/** Hidden marker in the pre-approval comment. Only github-actions[bot] markers count. */
export const DEDUPE_MARKER_KIND = "risk-assessment-dedupe";
export const ACTIONS_BOT_LOGIN = "github-actions[bot]";
export const CHECKS_WORKFLOW_PATH = ".github/workflows/checks.yml";
export const CHECKS_JOB_NAME = "secret-free checks";
export const GROK_ENVIRONMENT = "grok-assessment";
export const PREPARE_JOB_NAME = "prepare assessment inputs";
export const ASSESS_JOB_NAME = "assess with grok";
export const PREAPPROVAL_STEP_NAME = "Post the pre-approval summary";

export const CLOSED_GATE_REASON = "prior gate rejected/expired for this head and revision; recovery only";
export const GATE_OPEN_REASON = "gate already open";
export const UNCERTAIN_GATE_REASON = "prior gate history uncertain; recovery only";
export const CHECKS_INCOMPLETE_REASON = "check evidence incomplete";
export const CHECKS_PENDING_REASON = "required check pending";
export const PLAN_MISSING_REASON = "plan/approval missing";
export const API_UNAVAILABLE_REASON = "approvals or jobs API unavailable";
export const UPSTREAM_NOT_VISIBLE_REASON = "upstream checks not visible after re-read";
export const RECOVERY_REASON = "recovery dispatch";
export const PROCEED_REASON = "required checks completed";

/** About 3 re-reads, 10 seconds apart, then the automatic run skips. */
export const API_LAG_REREADS = 3;
export const API_LAG_DELAY_MS = 10_000;

const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const INCOMPLETE_CONCLUSIONS = new Set(["neutral", "skipped", "stale", "startup_failure"]);
const SHA = /^[0-9a-f]{40}$/;

export type TriggerDecision = "proceed" | "defer" | "skip" | "failed";
export type CheckStatus = "success" | "failure" | "pending" | "incomplete" | "none";

export type UpstreamRunRecord = {
  id: number;
  attempt: number;
  event: string;
  conclusion: string;
};

export type TriggerResult = {
  decision: TriggerDecision;
  proceed: boolean;
  reason: string;
  triggerMode: "workflow_run" | "recovery workflow_dispatch";
  prNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  assessorSha: string;
  planRevision: number | null;
  approvalCommentId: number | null;
  upstreamRuns: UpstreamRunRecord[];
  checkStatus: CheckStatus;
  postComment: boolean;
  marker: string | null;
  provenance: string;
  logLine: string;
  retryable: boolean;
};

export type ResolveTriggerInput = {
  owner: string;
  repo: string;
  eventName: string;
  assessorSha: string;
  assessmentRunId: number;
  trustedApprover: string;
  upstreamRunId?: number;
  upstreamRunAttempt?: number;
  upstreamHeadSha?: string;
  prNumber?: number;
  expectedHeadSha?: string;
};

export type DedupeMarker = {
  pr: number;
  head: string;
  revision: number;
  approvalId: number;
  checks: string;
  assessmentRunId: number;
};

type LoadedComment = { id?: number; body: string; author: string; source: number };

type RepoInfo = { id: number; fullName: string };

type WorkflowRunView = {
  id: number;
  attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  path: string;
  createdAt: string;
  repositoryId: number | null;
  repositoryFullName: string | null;
  headRepositoryId: number | null;
  headRepositoryFullName: string | null;
  headRepositoryFork: boolean;
};

type JobStepView = { name: string; status: string; conclusion: string | null };

type JobView = {
  name: string;
  status: string;
  conclusion: string | null;
  steps: JobStepView[];
  stepsKnown: boolean;
};

type ReviewView = { state: string; environments: string[] };

type CheckRunView = { name: string; status: string; conclusion: string | null; headSha: string | null };

export type PriorRunClass = "rejected" | "expired" | "waiting" | "none" | "uncertain" | "unreadable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function normalizeSha(value: string): string {
  return value.toLowerCase();
}

function repoPath(owner: string, repo: string, rest: string): string {
  return `/repos/${owner}/${repo}${rest}`;
}

export function canonicalChecks(runs: readonly { id: number; attempt: number }[]): string {
  return [...runs]
    .sort((left, right) => left.id - right.id || left.attempt - right.attempt)
    .map((run) => `${run.id}:${run.attempt}`)
    .join(",");
}

export function dedupeMarker(marker: DedupeMarker): string {
  return `<!-- ${DEDUPE_MARKER_KIND} pr=${marker.pr} head=${marker.head} revision=${marker.revision} approval=${marker.approvalId} checks=${marker.checks} assessment_run=${marker.assessmentRunId} -->`;
}

export function parseDedupeMarker(body: string): DedupeMarker | null {
  const match = body.match(
    /<!--\s*risk-assessment-dedupe\s+pr=(\d+)\s+head=([0-9a-f]{40})\s+revision=(\d+)\s+approval=(\d+)\s+checks=([0-9:,]*)\s+assessment_run=(\d+)\s*-->/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || match[5] === undefined || !match[6]) {
    return null;
  }
  const checks = match[5];
  if (checks.length > 0 && !/^[0-9]+:[0-9]+(?:,[0-9]+:[0-9]+)*$/.test(checks)) {
    return null;
  }
  return {
    pr: Number(match[1]),
    head: match[2],
    revision: Number(match[3]),
    approvalId: Number(match[4]),
    checks,
    assessmentRunId: Number(match[6]),
  };
}

export function formatProvenance(result: Pick<
  TriggerResult,
  "triggerMode" | "upstreamRuns" | "prNumber" | "headSha" | "baseSha" | "assessorSha" | "planRevision" | "decision" | "reason" | "checkStatus"
>): string {
  const upstream = result.upstreamRuns.length > 0
    ? result.upstreamRuns.map((run) => `${run.id}/${run.attempt} ${run.event} ${run.conclusion}`).join(", ")
    : "none";
  const pr = result.prNumber === null ? "none" : `#${result.prNumber}`;
  const revision = result.planRevision === null ? "missing" : String(result.planRevision);
  return [
    "## Trigger provenance",
    "",
    `- Trigger mode: ${result.triggerMode}`,
    `- Upstream runs: ${upstream}`,
    `- Pull request: ${pr}`,
    `- Head: ${result.headSha ?? "none"}`,
    `- Base: ${result.baseSha ?? "none"}`,
    `- Assessor commit: ${result.assessorSha}`,
    `- Plan revision: ${revision}`,
    `- Decision: ${result.decision}`,
    `- Reason: ${result.reason}`,
    `- Check status: ${result.checkStatus}`,
    "",
  ].join("\n");
}

function formatLog(result: Pick<
  TriggerResult,
  "triggerMode" | "upstreamRuns" | "prNumber" | "headSha" | "assessorSha" | "planRevision" | "decision" | "reason"
>): string {
  const upstream = result.upstreamRuns.length > 0
    ? result.upstreamRuns.map((run) => `${run.id}/${run.attempt} ${run.event} ${run.conclusion}`).join(", ")
    : "none";
  const pr = result.prNumber === null ? "none" : String(result.prNumber);
  const revision = result.planRevision === null ? "missing" : String(result.planRevision);
  const head = result.headSha ?? "none";
  const line = `Trigger mode: ${result.triggerMode}; upstream run ${upstream}; PR #${pr}; head ${head}; assessor ${result.assessorSha}; plan rev ${revision}; decision=${result.decision}`;
  if (result.decision === "proceed") {
    return line;
  }
  return `${line} reason=${result.reason}`;
}

function complete(draft: Omit<TriggerResult, "provenance" | "logLine" | "proceed" | "postComment"> & {
  postComment?: boolean;
}): TriggerResult {
  const proceed = draft.decision === "proceed";
  const result: TriggerResult = {
    ...draft,
    proceed,
    postComment: draft.postComment ?? proceed,
    provenance: "",
    logLine: "",
  };
  result.provenance = formatProvenance(result);
  result.logLine = formatLog(result);
  return result;
}

function blank(
  input: ResolveTriggerInput,
  triggerMode: TriggerResult["triggerMode"],
  decision: TriggerDecision,
  reason: string,
  extra: Partial<Omit<TriggerResult, "provenance" | "logLine" | "proceed" | "postComment" | "decision" | "reason" | "triggerMode">> = {},
): TriggerResult {
  return complete({
    decision,
    reason,
    triggerMode,
    prNumber: extra.prNumber ?? null,
    headSha: extra.headSha ?? null,
    baseSha: extra.baseSha ?? null,
    assessorSha: input.assessorSha,
    planRevision: extra.planRevision ?? null,
    approvalCommentId: extra.approvalCommentId ?? null,
    upstreamRuns: extra.upstreamRuns ?? [],
    checkStatus: extra.checkStatus ?? "none",
    marker: extra.marker ?? null,
    retryable: extra.retryable ?? false,
  });
}

async function read(client: GitHubClient, path: string): Promise<GitHubResponse | null> {
  try {
    return await client.get(path);
  } catch {
    return null;
  }
}

function parseRepo(body: unknown): RepoInfo | null {
  if (!isRecord(body) || typeof body.full_name !== "string") {
    return null;
  }
  const id = asNumber(body.id);
  if (id === undefined) {
    return null;
  }
  return { id, fullName: body.full_name };
}

function parseRepositorySide(value: unknown): { id: number | null; fullName: string | null; fork: boolean } {
  if (!isRecord(value)) {
    return { id: null, fullName: null, fork: true };
  }
  return {
    id: asNumber(value.id) ?? null,
    fullName: asString(value.full_name) ?? null,
    fork: value.fork === true,
  };
}

function parseWorkflowRun(body: unknown): WorkflowRunView | null {
  if (!isRecord(body)) {
    return null;
  }
  const id = asNumber(body.id);
  const attempt = asNumber(body.run_attempt);
  const event = asString(body.event);
  const status = asString(body.status);
  const headSha = asString(body.head_sha);
  const path = asString(body.path);
  if (id === undefined || attempt === undefined || !event || !status || !headSha || !path) {
    return null;
  }
  const repository = parseRepositorySide(body.repository);
  const headRepository = parseRepositorySide(body.head_repository);
  return {
    id,
    attempt,
    event,
    status,
    conclusion: body.conclusion === null ? null : asString(body.conclusion) ?? null,
    headSha: normalizeSha(headSha),
    headBranch: asString(body.head_branch) ?? null,
    path,
    createdAt: asString(body.created_at) ?? "",
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    headRepositoryId: headRepository.id,
    headRepositoryFullName: headRepository.fullName,
    headRepositoryFork: !isRecord(body.head_repository) || headRepository.fork,
  };
}

function parseWorkflowRunList(body: unknown): WorkflowRunView[] | null {
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
    return null;
  }
  const runs: WorkflowRunView[] = [];
  for (const entry of body.workflow_runs) {
    const run = parseWorkflowRun(entry);
    if (!run) {
      return null;
    }
    runs.push(run);
  }
  return runs;
}

function sameRepo(run: WorkflowRunView, repo: RepoInfo, owner: string, repoName: string): boolean {
  const fullName = `${owner}/${repoName}`;
  return run.repositoryId === repo.id && run.repositoryFullName === fullName && repo.fullName === fullName;
}

function sameHeadRepo(run: WorkflowRunView, repo: RepoInfo, owner: string, repoName: string): boolean {
  const fullName = `${owner}/${repoName}`;
  return !run.headRepositoryFork
    && run.headRepositoryId === repo.id
    && run.headRepositoryFullName === fullName
    && repo.fullName === fullName;
}

function toRecord(run: WorkflowRunView): UpstreamRunRecord {
  return {
    id: run.id,
    attempt: run.attempt,
    event: run.event,
    conclusion: run.conclusion ?? "none",
  };
}

type PullView = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
  headFork: boolean;
  headRepo: string | null;
  baseRef: string;
  baseSha: string | null;
  baseRepo: string | null;
  body: string;
};

function parsePull(body: unknown): PullView | null {
  if (!isRecord(body)) {
    return null;
  }
  const number = asNumber(body.number);
  const state = asString(body.state);
  const head = isRecord(body.head) ? body.head : undefined;
  const base = isRecord(body.base) ? body.base : undefined;
  const headSha = head ? asString(head.sha) : undefined;
  const baseRef = base ? asString(base.ref) : undefined;
  if (number === undefined || !state || !headSha || !baseRef) {
    return null;
  }
  const headRepo = head && isRecord(head.repo) ? head.repo : undefined;
  const baseRepo = base && isRecord(base.repo) ? base.repo : undefined;
  return {
    number,
    state,
    draft: body.draft === true,
    merged: body.merged_at !== null && body.merged_at !== undefined,
    headSha: normalizeSha(headSha),
    headFork: headRepo === undefined || headRepo.fork === true,
    headRepo: headRepo ? asString(headRepo.full_name) ?? null : null,
    baseRef,
    baseSha: base && asString(base.sha) ? normalizeSha(asString(base.sha) as string) : null,
    baseRepo: baseRepo ? asString(baseRepo.full_name) ?? null : null,
    body: asString(body.body) ?? "",
  };
}

function parsePullList(body: unknown): PullView[] | null {
  if (!Array.isArray(body)) {
    return null;
  }
  const pulls: PullView[] = [];
  for (const entry of body) {
    const pull = parsePull(entry);
    if (!pull) {
      return null;
    }
    pulls.push(pull);
  }
  return pulls;
}

function classifyPulls(pulls: readonly PullView[], headSha: string, fullName: string):
  | { kind: "one"; pull: PullView }
  | { kind: "skip"; reason: string } {
  const eligible = pulls.filter((pull) => {
    return pull.state === "open"
      && !pull.merged
      && pull.baseRef === "main"
      && pull.baseRepo === fullName
      && !pull.headFork
      && pull.headRepo === fullName
      && pull.headSha === headSha;
  });
  if (eligible.length > 1) {
    return { kind: "skip", reason: "ambiguous" };
  }
  if (eligible.length === 1 && eligible[0]) {
    return { kind: "one", pull: eligible[0] };
  }
  const sameRepoOpen = pulls.filter((pull) => pull.state === "open" && !pull.merged && pull.baseRef === "main" && pull.headRepo === fullName && !pull.headFork);
  if (sameRepoOpen.some((pull) => pull.headSha !== headSha)) {
    return { kind: "skip", reason: "stale head" };
  }
  if (pulls.some((pull) => pull.headFork || (pull.headRepo !== null && pull.headRepo !== fullName))) {
    return { kind: "skip", reason: "fork" };
  }
  if (pulls.some((pull) => pull.merged)) {
    return { kind: "skip", reason: "merged" };
  }
  if (pulls.some((pull) => pull.state === "closed")) {
    return { kind: "skip", reason: "closed" };
  }
  return { kind: "skip", reason: "none" };
}

function collapseAttempts(runs: readonly WorkflowRunView[]): WorkflowRunView[] {
  const byId = new Map<number, WorkflowRunView>();
  for (const run of runs) {
    const current = byId.get(run.id);
    if (!current || run.attempt > current.attempt) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()];
}

function isNewer(candidate: WorkflowRunView, current: WorkflowRunView): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);
  const left = Number.isFinite(candidateTime) ? candidateTime : 0;
  const right = Number.isFinite(currentTime) ? currentTime : 0;
  if (left !== right) {
    return left > right;
  }
  return candidate.id > current.id;
}

function latestRequired(runs: readonly WorkflowRunView[], headSha: string): { push?: WorkflowRunView; pull_request?: WorkflowRunView } {
  const scoped = collapseAttempts(runs).filter((run) => {
    return run.path === CHECKS_WORKFLOW_PATH && run.headSha === headSha && (run.event === "push" || run.event === "pull_request");
  });
  const chosen: { push?: WorkflowRunView; pull_request?: WorkflowRunView } = {};
  for (const run of scoped) {
    if (run.event === "push") {
      if (!chosen.push || isNewer(run, chosen.push)) {
        chosen.push = run;
      }
    } else if (!chosen.pull_request || isNewer(run, chosen.pull_request)) {
      chosen.pull_request = run;
    }
  }
  return chosen;
}

function conclusionClass(status: string, conclusion: string | null): "success" | "failure" | "pending" | "incomplete" {
  if (status !== "completed") {
    return "pending";
  }
  if (conclusion === "success") {
    return "success";
  }
  if (conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion)) {
    return "failure";
  }
  return "incomplete";
}

function parseCheckRuns(body: unknown): CheckRunView[] | null {
  if (!isRecord(body) || !Array.isArray(body.check_runs)) {
    return null;
  }
  const runs: CheckRunView[] = [];
  for (const entry of body.check_runs) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.status !== "string") {
      return null;
    }
    runs.push({
      name: entry.name,
      status: entry.status,
      conclusion: entry.conclusion === null ? null : asString(entry.conclusion) ?? null,
      headSha: asString(entry.head_sha) ? normalizeSha(asString(entry.head_sha) as string) : null,
    });
  }
  return runs;
}

function commentsFrom(body: unknown, source: number): LoadedComment[] | null {
  if (!Array.isArray(body)) {
    return null;
  }
  const comments: LoadedComment[] = [];
  for (const item of body) {
    if (!isRecord(item) || typeof item.body !== "string" || !isRecord(item.user) || typeof item.user.login !== "string") {
      return null;
    }
    const id = asNumber(item.id);
    comments.push({ ...(id !== undefined ? { id } : {}), body: item.body, author: item.user.login, source });
  }
  return comments;
}

function parseJobs(body: unknown): JobView[] | null {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.jobs) ? body.jobs : null;
  if (!list) {
    return null;
  }
  const jobs: JobView[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.status !== "string") {
      return null;
    }
    const steps: JobStepView[] = [];
    let stepsKnown = false;
    if (Array.isArray(entry.steps)) {
      stepsKnown = true;
      for (const step of entry.steps) {
        if (!isRecord(step) || typeof step.name !== "string") {
          return null;
        }
        steps.push({
          name: step.name,
          status: asString(step.status) ?? "",
          conclusion: step.conclusion === null || step.conclusion === undefined ? null : asString(step.conclusion) ?? null,
        });
      }
    } else if (entry.steps !== undefined && entry.steps !== null) {
      return null;
    }
    jobs.push({
      name: entry.name,
      status: entry.status,
      conclusion: entry.conclusion === null || entry.conclusion === undefined ? null : asString(entry.conclusion) ?? null,
      steps,
      stepsKnown,
    });
  }
  return jobs;
}

function parseApprovals(body: unknown): ReviewView[] | null {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.approvals) ? body.approvals : null;
  if (!list) {
    return null;
  }
  const reviews: ReviewView[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.state !== "string") {
      return null;
    }
    const environments: string[] = [];
    if (Array.isArray(entry.environments)) {
      for (const environment of entry.environments) {
        if (isRecord(environment) && typeof environment.name === "string") {
          environments.push(environment.name);
        } else if (typeof environment === "string") {
          environments.push(environment);
        } else {
          return null;
        }
      }
    }
    reviews.push({ state: entry.state, environments });
  }
  return reviews;
}

const EXECUTED_STEP_CONCLUSIONS = new Set(["success", "failure", "cancelled", "timed_out", "action_required"]);

function stepExecuted(step: JobStepView): boolean {
  if (step.status === "in_progress") {
    return true;
  }
  return step.status === "completed" && step.conclusion !== null && EXECUTED_STEP_CONCLUSIONS.has(step.conclusion);
}

function anyStepExecuted(job: JobView): boolean {
  return job.steps.some(stepExecuted);
}

function prepareProceeded(job: JobView): boolean {
  if (!job.stepsKnown || job.conclusion !== "success" || job.status !== "completed") {
    return false;
  }
  return job.steps.some((step) => step.name === PREAPPROVAL_STEP_NAME && stepExecuted(step) && step.conclusion === "success");
}

function hasGrokApproval(reviews: readonly ReviewView[]): boolean {
  return reviews.some((review) => review.state === "approved" && review.environments.includes(GROK_ENVIRONMENT));
}

/**
 * Expired: prepare posted, the approvals API has no grok-assessment approval, and
 * assess finished failure or cancelled without an executed step. Timestamps are
 * not execution. If that post step is missing, renamed, empty, or skipped, the
 * same completed assess is uncertain. A skipped or deferred assess is not a gate.
 * An approval followed by executed steps, including a later failure, is not expiry.
 */
export function classifyPriorRun(approvalsBody: unknown, jobsBody: unknown): PriorRunClass {
  const approvals = parseApprovals(approvalsBody);
  const jobs = parseJobs(jobsBody);
  if (!approvals || !jobs) {
    return "unreadable";
  }
  for (const review of approvals) {
    if (review.state !== "rejected") {
      continue;
    }
    if (review.environments.length === 0) {
      return "unreadable";
    }
    if (review.environments.includes(GROK_ENVIRONMENT)) {
      return "rejected";
    }
  }
  const prepare = jobs.find((job) => job.name === PREPARE_JOB_NAME);
  const assess = jobs.find((job) => job.name === ASSESS_JOB_NAME);
  if (!prepare) {
    return "unreadable";
  }
  if (!assess) {
    return prepare.status === "completed" ? "unreadable" : "waiting";
  }
  if (assess.conclusion === "skipped") {
    return "none";
  }
  if (!assess.stepsKnown || !prepare.stepsKnown) {
    return "uncertain";
  }
  if (assess.status === "waiting") {
    return "waiting";
  }
  const executed = anyStepExecuted(assess);
  if (assess.status !== "completed" || assess.conclusion === null) {
    return executed ? "waiting" : "uncertain";
  }
  if (executed) {
    return "none";
  }
  if (
    !hasGrokApproval(approvals) &&
    prepareProceeded(prepare) &&
    (assess.conclusion === "failure" || assess.conclusion === "cancelled")
  ) {
    return "expired";
  }
  if (!prepareProceeded(prepare)) {
    if (assess.conclusion === "failure" || assess.conclusion === "cancelled") {
      return "uncertain";
    }
    return "none";
  }
  return "uncertain";
}

function markerMatchesCandidate(marker: DedupeMarker, pr: number, head: string, revision: number): boolean {
  return marker.pr === pr && marker.head === head && marker.revision === revision;
}

function botMarkers(comments: readonly LoadedComment[]): { ok: true; markers: DedupeMarker[] } | { ok: false } {
  const markers: DedupeMarker[] = [];
  for (const comment of comments) {
    if (comment.author !== ACTIONS_BOT_LOGIN || !comment.body.includes(DEDUPE_MARKER_KIND)) {
      continue;
    }
    const marker = parseDedupeMarker(comment.body);
    if (!marker) {
      return { ok: false };
    }
    markers.push(marker);
  }
  return { ok: true, markers };
}

async function loadComments(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  prBody: string,
): Promise<LoadedComment[] | null> {
  const sources = [prNumber, ...linkedIssueNumbers(prBody).filter((issue) => issue !== prNumber)];
  const comments: LoadedComment[] = [];
  for (const source of sources) {
    const response = await read(client, repoPath(owner, repo, `/issues/${source}/comments?per_page=100`));
    if (!response || response.status !== 200 || response.linkNext) {
      return null;
    }
    const parsed = commentsFrom(response.body, source);
    if (!parsed) {
      return null;
    }
    comments.push(...parsed);
  }
  return comments;
}

function approvalIdFor(
  comments: readonly LoadedComment[],
  approval: { author: string; body: string },
  source: number,
): number | null {
  const match = comments.find((comment) => {
    return comment.source === source && comment.author === approval.author && comment.body.trim() === approval.body;
  });
  return match?.id ?? null;
}

function buildMarker(
  pr: number,
  head: string,
  revision: number,
  approvalId: number,
  checks: string,
  assessmentRunId: number,
): string {
  return dedupeMarker({ pr, head, revision, approvalId, checks, assessmentRunId });
}

async function evaluatePriorGates(
  client: GitHubClient,
  owner: string,
  repo: string,
  markers: readonly DedupeMarker[],
): Promise<{ kind: "clear" } | { kind: "skip"; reason: string }> {
  let waiting = false;
  const seen = new Set<number>();
  for (const marker of markers) {
    if (seen.has(marker.assessmentRunId)) {
      continue;
    }
    seen.add(marker.assessmentRunId);
    const approvals = await read(client, repoPath(owner, repo, `/actions/runs/${marker.assessmentRunId}/approvals`));
    const jobs = await read(client, repoPath(owner, repo, `/actions/runs/${marker.assessmentRunId}/jobs`));
    if (!approvals || approvals.status !== 200 || approvals.linkNext || !jobs || jobs.status !== 200 || jobs.linkNext) {
      return { kind: "skip", reason: API_UNAVAILABLE_REASON };
    }
    const classified = classifyPriorRun(approvals.body, jobs.body);
    if (classified === "unreadable") {
      return { kind: "skip", reason: API_UNAVAILABLE_REASON };
    }
    if (classified === "uncertain") {
      return { kind: "skip", reason: UNCERTAIN_GATE_REASON };
    }
    if (classified === "rejected" || classified === "expired") {
      return { kind: "skip", reason: CLOSED_GATE_REASON };
    }
    if (classified === "waiting") {
      waiting = true;
    }
  }
  if (waiting) {
    return { kind: "skip", reason: GATE_OPEN_REASON };
  }
  return { kind: "clear" };
}

function normalizeChecks(value: string): string {
  if (value.length === 0) {
    return "";
  }
  const parts = value.split(",").map((part) => {
    const [id, attempt] = part.split(":");
    return { id: Number(id), attempt: Number(attempt) };
  });
  return canonicalChecks(parts);
}

function findDuplicate(markers: readonly DedupeMarker[], approvalId: number, checks: string): number | null {
  const expected = normalizeChecks(checks);
  const matches = markers.filter((marker) => marker.approvalId === approvalId && normalizeChecks(marker.checks) === expected);
  if (matches.length === 0) {
    return null;
  }
  return Math.min(...matches.map((marker) => marker.assessmentRunId));
}

async function resolveRecovery(client: GitHubClient, input: ResolveTriggerInput): Promise<TriggerResult> {
  const prNumber = input.prNumber;
  const head = input.expectedHeadSha ?? "";
  if (prNumber === undefined || !Number.isInteger(prNumber) || prNumber < 1) {
    return blank(input, "recovery workflow_dispatch", "failed", "pr_number must be a positive integer");
  }
  if (!SHA.test(head)) {
    return blank(input, "recovery workflow_dispatch", "failed", "expected_head_sha must be 40 hexadecimal characters", {
      prNumber,
    });
  }
  let baseSha: string | null = null;
  let planRevision: number | null = null;
  let approvalCommentId: number | null = null;
  let marker: string | null = null;
  const pullResponse = await read(client, repoPath(input.owner, input.repo, `/pulls/${prNumber}`));
  const pull = pullResponse && pullResponse.status === 200 && !pullResponse.linkNext ? parsePull(pullResponse.body) : null;
  if (pull?.baseSha && SHA.test(pull.baseSha)) {
    baseSha = pull.baseSha;
  }
  if (pull) {
    const comments = await loadComments(client, input.owner, input.repo, prNumber, pull.body);
    if (comments) {
      const planResult = selectPlan(comments);
      if (planResult.ok) {
        planRevision = planResult.plan.revision;
        const approval = selectApproval(comments, planResult.plan.revision, input.trustedApprover, planResult.plan.issue);
        if (approval) {
          approvalCommentId = approvalIdFor(comments, approval, planResult.plan.issue);
        }
        marker = buildMarker(prNumber, head, planRevision, approvalCommentId ?? 0, "", input.assessmentRunId);
      }
    }
  }
  return blank(input, "recovery workflow_dispatch", "proceed", RECOVERY_REASON, {
    prNumber,
    headSha: head,
    baseSha,
    planRevision,
    approvalCommentId,
    marker,
    checkStatus: "none",
  });
}

async function resolveAutomatic(client: GitHubClient, input: ResolveTriggerInput): Promise<TriggerResult> {
  const mode = "workflow_run" as const;
  const upstreamId = input.upstreamRunId;
  const upstreamAttempt = input.upstreamRunAttempt;
  const upstreamHead = input.upstreamHeadSha ?? "";
  if (
    upstreamId === undefined
    || upstreamAttempt === undefined
    || !Number.isInteger(upstreamId)
    || upstreamId < 1
    || !Number.isInteger(upstreamAttempt)
    || upstreamAttempt < 1
    || !SHA.test(upstreamHead)
    || !SHA.test(input.assessorSha)
    || !Number.isInteger(input.assessmentRunId)
    || input.assessmentRunId < 1
  ) {
    return blank(input, mode, "skip", "payload/API mismatch");
  }

  const repoResponse = await read(client, repoPath(input.owner, input.repo, ""));
  if (!repoResponse || repoResponse.status !== 200) {
    return blank(input, mode, "skip", "upstream checks not visible", {
      headSha: upstreamHead,
      retryable: true,
    });
  }
  const repo = parseRepo(repoResponse.body);
  if (!repo || repo.fullName !== `${input.owner}/${input.repo}`) {
    return blank(input, mode, "skip", "wrong repo", { headSha: upstreamHead });
  }

  const runResponse = await read(client, repoPath(input.owner, input.repo, `/actions/runs/${upstreamId}`));
  if (!runResponse || runResponse.status !== 200 || runResponse.linkNext) {
    return blank(input, mode, "skip", "upstream checks not visible", {
      headSha: upstreamHead,
      retryable: true,
    });
  }
  const triggering = parseWorkflowRun(runResponse.body);
  if (!triggering) {
    return blank(input, mode, "skip", "payload/API mismatch", { headSha: upstreamHead });
  }
  const triggeringRecord = [toRecord(triggering)];
  if (triggering.path !== CHECKS_WORKFLOW_PATH) {
    return blank(input, mode, "skip", "wrong workflow path", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (!sameRepo(triggering, repo, input.owner, input.repo)) {
    return blank(input, mode, "skip", "wrong repo", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (!sameHeadRepo(triggering, repo, input.owner, input.repo)) {
    return blank(input, mode, "skip", "fork", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (triggering.event !== "push" && triggering.event !== "pull_request") {
    return blank(input, mode, "skip", "payload/API mismatch", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (triggering.id !== upstreamId || triggering.attempt !== upstreamAttempt || triggering.headSha !== upstreamHead) {
    return blank(input, mode, "skip", "payload/API mismatch", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (triggering.event === "push" && triggering.headBranch === "main") {
    return blank(input, mode, "skip", "main push", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  if (triggering.status !== "completed") {
    return blank(input, mode, "skip", "upstream checks not visible", {
      headSha: upstreamHead,
      upstreamRuns: triggeringRecord,
      retryable: true,
    });
  }

  const pullsResponse = await read(client, repoPath(input.owner, input.repo, `/commits/${upstreamHead}/pulls`));
  if (!pullsResponse || pullsResponse.status !== 200 || pullsResponse.linkNext) {
    return blank(input, mode, "skip", "payload/API mismatch", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  const pulls = parsePullList(pullsResponse.body);
  if (!pulls) {
    return blank(input, mode, "skip", "payload/API mismatch", { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  const classified = classifyPulls(pulls, upstreamHead, repo.fullName);
  if (classified.kind === "skip") {
    return blank(input, mode, "skip", classified.reason, { headSha: upstreamHead, upstreamRuns: triggeringRecord });
  }
  const candidate = classified.pull;
  const fullResponse = await read(client, repoPath(input.owner, input.repo, `/pulls/${candidate.number}`));
  const full = fullResponse && fullResponse.status === 200 && !fullResponse.linkNext ? parsePull(fullResponse.body) : null;
  if (!full || !full.baseSha || !SHA.test(full.baseSha)) {
    return blank(input, mode, "skip", "payload/API mismatch", {
      prNumber: candidate.number,
      headSha: upstreamHead,
      upstreamRuns: triggeringRecord,
    });
  }
  if (full.headSha !== upstreamHead || full.state !== "open" || full.merged || full.baseRef !== "main" || full.headFork) {
    const reason = full.headSha !== upstreamHead ? "stale head" : full.headFork ? "fork" : full.merged ? "merged" : full.state === "closed" ? "closed" : "none";
    return blank(input, mode, "skip", reason, {
      prNumber: full.number,
      headSha: upstreamHead,
      baseSha: full.baseSha,
      upstreamRuns: triggeringRecord,
    });
  }

  const shared = {
    prNumber: full.number,
    headSha: upstreamHead,
    baseSha: full.baseSha,
    upstreamRuns: triggeringRecord,
  };

  const runsResponse = await read(
    client,
    repoPath(input.owner, input.repo, `/actions/workflows/checks.yml/runs?head_sha=${upstreamHead}&per_page=100`),
  );
  if (!runsResponse || runsResponse.status !== 200 || runsResponse.linkNext) {
    return blank(input, mode, "skip", "upstream checks not visible", { ...shared, retryable: true });
  }
  const listed = parseWorkflowRunList(runsResponse.body);
  if (!listed) {
    return blank(input, mode, "skip", "payload/API mismatch", shared);
  }
  if (!listed.some((run) => run.id === triggering.id)) {
    return blank(input, mode, "skip", "upstream checks not visible", { ...shared, retryable: true });
  }
  const required = latestRequired(listed, upstreamHead);
  const push = required.push;
  const pullRequest = required.pull_request;
  if (!push || !pullRequest) {
    const have = [push, pullRequest].filter((run): run is WorkflowRunView => run !== undefined).map(toRecord);
    return blank(input, mode, "defer", CHECKS_PENDING_REASON, {
      ...shared,
      upstreamRuns: have.length > 0 ? have : triggeringRecord,
      checkStatus: "pending",
    });
  }
  const requiredRuns = [push, pullRequest];
  const requiredRecords = requiredRuns.map(toRecord);
  const classes = requiredRuns.map((run) => conclusionClass(run.status, run.conclusion));
  if (classes.some((item) => item === "pending")) {
    return blank(input, mode, "defer", CHECKS_PENDING_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus: "pending",
    });
  }
  if (classes.some((item) => item === "incomplete")) {
    return blank(input, mode, "skip", CHECKS_INCOMPLETE_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus: "incomplete",
    });
  }

  const checksResponse = await read(client, repoPath(input.owner, input.repo, `/commits/${upstreamHead}/check-runs?per_page=100`));
  if (!checksResponse || checksResponse.status !== 200 || checksResponse.linkNext) {
    return blank(input, mode, "skip", "upstream checks not visible", {
      ...shared,
      upstreamRuns: requiredRecords,
      retryable: true,
    });
  }
  const checkRuns = parseCheckRuns(checksResponse.body);
  if (!checkRuns) {
    return blank(input, mode, "skip", "payload/API mismatch", { ...shared, upstreamRuns: requiredRecords });
  }
  const requiredChecks = checkRuns.filter((run) => run.name === CHECKS_JOB_NAME && (run.headSha === null || run.headSha === upstreamHead));
  if (requiredChecks.length < requiredRuns.length) {
    return blank(input, mode, "skip", "upstream checks not visible", {
      ...shared,
      upstreamRuns: requiredRecords,
      retryable: true,
    });
  }
  const checkClasses = requiredChecks.map((run) => conclusionClass(run.status, run.conclusion));
  const combined = [...classes, ...checkClasses];
  if (combined.some((item) => item === "pending")) {
    return blank(input, mode, "defer", CHECKS_PENDING_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus: "pending",
    });
  }
  if (combined.some((item) => item === "incomplete")) {
    return blank(input, mode, "skip", CHECKS_INCOMPLETE_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus: "incomplete",
    });
  }
  const checkStatus: CheckStatus = combined.some((item) => item === "failure") ? "failure" : "success";
  const checksKey = canonicalChecks(requiredRuns.map((run) => ({ id: run.id, attempt: run.attempt })));

  const comments = await loadComments(client, input.owner, input.repo, full.number, full.body);
  if (!comments) {
    return blank(input, mode, "skip", PLAN_MISSING_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
    });
  }
  const planResult = selectPlan(comments);
  if (!planResult.ok) {
    return blank(input, mode, "skip", PLAN_MISSING_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
    });
  }
  const plan = planResult.plan;
  const approval = selectApproval(comments, plan.revision, input.trustedApprover, plan.issue);
  const foundApprovalId = approval ? approvalIdFor(comments, approval, plan.issue) : null;
  if (!approval || foundApprovalId === null) {
    return blank(input, mode, "skip", PLAN_MISSING_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
      planRevision: plan.revision,
    });
  }

  const parsedMarkers = botMarkers(comments);
  if (!parsedMarkers.ok) {
    return blank(input, mode, "skip", API_UNAVAILABLE_REASON, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
      planRevision: plan.revision,
      approvalCommentId: foundApprovalId,
    });
  }
  const prior = parsedMarkers.markers.filter((marker) => markerMatchesCandidate(marker, full.number, upstreamHead, plan.revision));
  const gate = await evaluatePriorGates(client, input.owner, input.repo, prior);
  if (gate.kind === "skip") {
    return blank(input, mode, "skip", gate.reason, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
      planRevision: plan.revision,
      approvalCommentId: foundApprovalId,
    });
  }
  const duplicate = findDuplicate(prior, foundApprovalId, checksKey);
  if (duplicate !== null) {
    return blank(input, mode, "skip", `duplicate of run ${duplicate}`, {
      ...shared,
      upstreamRuns: requiredRecords,
      checkStatus,
      planRevision: plan.revision,
      approvalCommentId: foundApprovalId,
    });
  }

  return blank(input, mode, "proceed", PROCEED_REASON, {
    ...shared,
    upstreamRuns: requiredRecords,
    checkStatus,
    planRevision: plan.revision,
    approvalCommentId: foundApprovalId,
    marker: buildMarker(full.number, upstreamHead, plan.revision, foundApprovalId, checksKey, input.assessmentRunId),
  });
}

export async function resolveTrigger(client: GitHubClient, input: ResolveTriggerInput): Promise<TriggerResult> {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.owner) || !/^[A-Za-z0-9_.-]+$/.test(input.repo)) {
    return blank(input, input.eventName === "workflow_dispatch" ? "recovery workflow_dispatch" : "workflow_run", "failed", "repository name is invalid");
  }
  if (!SHA.test(input.assessorSha)) {
    return blank(input, input.eventName === "workflow_dispatch" ? "recovery workflow_dispatch" : "workflow_run", "failed", "assessor SHA must be 40 hexadecimal characters");
  }
  if (input.eventName === "workflow_dispatch") {
    return resolveRecovery(client, input);
  }
  if (input.eventName !== "workflow_run") {
    return blank(input, "workflow_run", "skip", "payload/API mismatch");
  }
  return resolveAutomatic(client, input);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function resolveTriggerWithReread(
  client: GitHubClient,
  input: ResolveTriggerInput,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<TriggerResult> {
  let result = await resolveTrigger(client, input);
  for (let attempt = 0; attempt < API_LAG_REREADS && result.retryable; attempt += 1) {
    await sleep(API_LAG_DELAY_MS);
    result = await resolveTrigger(client, input);
  }
  if (result.retryable) {
    return complete({
      ...result,
      decision: "skip",
      reason: UPSTREAM_NOT_VISIBLE_REASON,
      marker: null,
      retryable: false,
      postComment: false,
    });
  }
  return result;
}

export function githubFetchClient(token: string): GitHubClient {
  return {
    async get(path: string): Promise<GitHubResponse> {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "build-something-risk-assessor",
        },
      });
      const link = response.headers.get("link") ?? "";
      let body: unknown = null;
      if (response.status !== 204) {
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, linkNext: link.includes('rel="next"') };
    },
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(value.trim())) {
    return Number.NaN;
  }
  return Number(value.trim());
}

export function inputFromEnv(env: Record<string, string | undefined>): { ok: true; input: ResolveTriggerInput } | { ok: false; message: string } {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const assessorSha = requiredEnv(env, "ASSESSOR_SHA");
  const assessmentRun = optionalInteger(env.ASSESSMENT_RUN_ID);
  if (!repository || !repository.includes("/") || repository.split("/").length !== 2) {
    return { ok: false, message: "GITHUB_REPOSITORY must be owner/repo" };
  }
  if (!assessorSha || !SHA.test(assessorSha)) {
    return { ok: false, message: "ASSESSOR_SHA must be 40 hexadecimal characters" };
  }
  if (assessmentRun === undefined || Number.isNaN(assessmentRun)) {
    return { ok: false, message: "ASSESSMENT_RUN_ID must be a positive integer" };
  }
  const [owner, repo] = repository.split("/") as [string, string];
  const eventName = requiredEnv(env, "GITHUB_EVENT_NAME") ?? "";
  return {
    ok: true,
    input: {
      owner,
      repo,
      eventName,
      assessorSha,
      assessmentRunId: assessmentRun,
      trustedApprover: env.ASSESSMENT_APPROVER?.trim() ?? "",
      upstreamRunId: optionalInteger(env.UPSTREAM_RUN_ID),
      upstreamRunAttempt: optionalInteger(env.UPSTREAM_RUN_ATTEMPT),
      upstreamHeadSha: env.UPSTREAM_HEAD_SHA?.trim() || undefined,
      prNumber: optionalInteger(env.PR_NUMBER),
      expectedHeadSha: env.EXPECTED_HEAD_SHA?.trim() || undefined,
    },
  };
}

export async function executeTriggerCli(options: {
  env: Record<string, string | undefined>;
  client: GitHubClient;
  writeOutput: (name: string, value: string) => void;
  writeSummary: (text: string) => void;
  writeAnnotation: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const parsed = inputFromEnv(options.env);
  if (!parsed.ok) {
    options.writeSummary(parsed.message);
    return 1;
  }
  const result = await resolveTriggerWithReread(options.client, parsed.input, options.sleep);
  options.writeOutput("decision", result.decision);
  options.writeOutput("proceed", result.proceed ? "true" : "false");
  options.writeOutput("reason", result.reason);
  options.writeOutput("trigger_mode", result.triggerMode);
  options.writeOutput("pr_number", result.prNumber === null ? "" : String(result.prNumber));
  options.writeOutput("expected_head_sha", result.headSha ?? "");
  options.writeOutput("base_sha", result.baseSha ?? "");
  options.writeOutput("plan_revision", result.planRevision === null ? "" : String(result.planRevision));
  options.writeOutput("upstream_runs", result.upstreamRuns.map((run) => `${run.id}/${run.attempt} ${run.event} ${run.conclusion}`).join(", "));
  options.writeOutput("check_status", result.checkStatus);
  const annotation = result.marker ? `${result.provenance}\n${result.marker}\n` : `${result.provenance}\n`;
  options.writeSummary(`${result.logLine}\n\n${annotation}`);
  if (result.postComment) {
    options.writeAnnotation(annotation);
  }
  return result.decision === "failed" ? 1 : 0;
}

function runningAsCli(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith(`${path.sep}trigger.ts`) || entry.endsWith(`${path.sep}trigger.js`);
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN?.trim() ?? "";
  if (token.length === 0) {
    console.error("GH_TOKEN is not set");
    process.exit(1);
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const code = await executeTriggerCli({
    env: process.env,
    client: githubFetchClient(token),
    writeOutput: (name, value) => {
      if (outputPath) {
        appendFileSync(outputPath, `${name}=${value}\n`);
      }
    },
    writeSummary: (text) => {
      if (summaryPath) {
        appendFileSync(summaryPath, text);
      }
      console.log(text);
    },
    writeAnnotation: (text) => {
      writeFileSync("trigger-annotation.md", text);
    },
  });
  if (code !== 0) {
    process.exit(code);
  }
}

if (runningAsCli()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "trigger failed";
    console.error(message);
    process.exit(1);
  });
}
