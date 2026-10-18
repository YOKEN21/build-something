import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { mapCheckRuns, type GitHubClient, type GitHubResponse } from "../src/risk-assessor/collect";
import {
  API_LAG_DELAY_MS,
  API_LAG_REREADS,
  API_UNAVAILABLE_REASON,
  CHECKS_INCOMPLETE_REASON,
  CHECKS_PENDING_REASON,
  CLOSED_GATE_REASON,
  GATE_OPEN_REASON,
  PLAN_MISSING_REASON,
  UPSTREAM_NOT_VISIBLE_REASON,
  canonicalChecks,
  classifyPriorRun,
  dedupeMarker,
  executeTriggerCli,
  parseDedupeMarker,
  resolveTrigger,
  resolveTriggerWithReread,
  type ResolveTriggerInput,
} from "../src/risk-assessor/trigger";

const repoRoot = path.resolve(__dirname, "..");
const workflowPath = path.join(repoRoot, ".github/workflows/risk-assessment.yml");
const workflow = readFileSync(workflowPath, "utf8");

const HEAD = "a".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const BASE = "b".repeat(40);
const ASSESSOR = "c".repeat(40);
const OWNER = "YOKEN21";
const REPO = "build-something";
const FULL = `${OWNER}/${REPO}`;
const REPO_ID = 4242;
const SENTINEL = "SECRET-TITLE-SENTINEL";
const MESSAGE_SENTINEL = "SECRET-MESSAGE-SENTINEL";

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("real network call attempted");
}) as typeof fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

type RunSpec = {
  id: number;
  attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  path: string;
  name: string;
  createdAt: string;
  repoId: number;
  repoFullName: string;
  headRepoId: number;
  headRepoFullName: string;
  fork: boolean;
  pullRequests?: { number: number }[];
};

type PullSpec = {
  number: number;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  headSha: string;
  headFork: boolean;
  headRepo: string;
  baseRef: string;
  baseSha: string;
  baseRepo: string;
  body: string;
};

type CommentSpec = { id: number; body: string; login: string };

type CheckSpec = { id: number; name: string; status: string; conclusion: string | null; head_sha?: string };

type PriorSpec = {
  approvals: unknown;
  jobs: unknown;
  approvalsStatus?: number;
  jobsStatus?: number;
};

type Scenario = {
  input?: Partial<ResolveTriggerInput>;
  triggering?: Partial<RunSpec>;
  push?: Partial<RunSpec>;
  listedRuns?: RunSpec[];
  pulls?: PullSpec[];
  fullPull?: Partial<PullSpec> | null;
  prComments?: CommentSpec[];
  issueComments?: CommentSpec[] | null;
  checkRuns?: CheckSpec[];
  prior?: Record<number, PriorSpec>;
  repoStatus?: number;
  runStatus?: number;
  pullsStatus?: number;
  listStatus?: number;
  checksStatus?: number;
  commentsStatus?: number;
  plan?: boolean;
  approval?: boolean;
  revision?: number;
  issue?: number;
  approvalId?: number;
  approvalAuthor?: string;
  approver?: string;
};

function runSpec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    id: 101,
    attempt: 1,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    headBranch: "feature",
    path: ".github/workflows/checks.yml",
    name: "checks",
    createdAt: "2026-10-18T00:05:00Z",
    repoId: REPO_ID,
    repoFullName: FULL,
    headRepoId: REPO_ID,
    headRepoFullName: FULL,
    fork: false,
    pullRequests: [{ number: 999 }],
    ...over,
  };
}

function toApiRun(run: RunSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: run.id,
    run_attempt: run.attempt,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    head_sha: run.headSha,
    head_branch: run.headBranch,
    path: run.path,
    name: run.name,
    created_at: run.createdAt,
    display_title: SENTINEL,
    head_commit: { message: MESSAGE_SENTINEL },
    repository: { id: run.repoId, full_name: run.repoFullName },
    head_repository: { id: run.headRepoId, full_name: run.headRepoFullName, fork: run.fork },
  };
  if (run.pullRequests) {
    body.pull_requests = run.pullRequests;
  }
  return body;
}

function pullSpec(over: Partial<PullSpec> = {}): PullSpec {
  return {
    number: 14,
    state: "open",
    draft: false,
    mergedAt: null,
    headSha: HEAD,
    headFork: false,
    headRepo: FULL,
    baseRef: "main",
    baseSha: BASE,
    baseRepo: FULL,
    body: "see #12",
    ...over,
  };
}

function toApiPull(pull: PullSpec): Record<string, unknown> {
  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    merged_at: pull.mergedAt,
    body: pull.body,
    title: SENTINEL,
    head: { sha: pull.headSha, ref: "feature", repo: { full_name: pull.headRepo, fork: pull.headFork } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { full_name: pull.baseRepo } },
  };
}

function planBody(revision: number, issue: number): string {
  return [
    `## Plan revision ${revision}`,
    "Request summary: Raise CPU.",
    "Change type: config-change",
    "Product: matter",
    "Service: matter-search",
    "Environment: dev",
    "Allowed paths: services/matter/matter-search/config.json",
    "Acceptance expectation: Stay within defaults.",
    `Revision: ${revision}`,
    `Issue: ${issue}`,
  ].join("\n");
}

function toApiComment(comment: CommentSpec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: comment.login } };
}

function response(status: number, body: unknown): GitHubResponse {
  return { status, body, linkNext: false };
}

function prepareJob(proceeded: boolean): Record<string, unknown> {
  return {
    name: "prepare assessment inputs",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-18T00:00:00Z",
    steps: [
      {
        name: "Post the pre-approval summary",
        status: "completed",
        conclusion: proceeded ? "success" : "skipped",
      },
    ],
  };
}

function assessJob(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "assess with grok",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-18T01:00:00Z",
    steps: [{ name: "Run the trusted assessor", status: "completed", conclusion: "success" }],
    ...over,
  };
}

function jobsOf(...jobs: Record<string, unknown>[]): { jobs: Record<string, unknown>[] } {
  return { jobs };
}

function rejectedReview(): Record<string, unknown>[] {
  return [{ state: "rejected", environments: [{ name: "grok-assessment" }] }];
}

function approvedReview(): Record<string, unknown>[] {
  return [{ state: "approved", environments: [{ name: "grok-assessment" }] }];
}

function expiredJobs(): { jobs: Record<string, unknown>[] } {
  return jobsOf(
    prepareJob(true),
    assessJob({
      status: "completed",
      conclusion: "cancelled",
      started_at: null,
      steps: [],
      environment: { name: "grok-assessment" },
    }),
  );
}

function skippedAssessJobs(): { jobs: Record<string, unknown>[] } {
  return jobsOf(prepareJob(false), assessJob({ status: "completed", conclusion: "skipped", started_at: null, steps: [] }));
}

function startedJobs(): { jobs: Record<string, unknown>[] } {
  return jobsOf(prepareJob(true), assessJob({ environment: { name: "grok-assessment" } }));
}

const defaultInput: ResolveTriggerInput = {
  owner: OWNER,
  repo: REPO,
  eventName: "workflow_run",
  assessorSha: ASSESSOR,
  assessmentRunId: 777,
  trustedApprover: "kenny-synthetic",
  upstreamRunId: 101,
  upstreamRunAttempt: 1,
  upstreamHeadSha: HEAD,
};

async function runScenario(scenario: Scenario = {}): Promise<{ result: Awaited<ReturnType<typeof resolveTrigger>>; calls: string[]; input: ResolveTriggerInput }> {
  const input: ResolveTriggerInput = {
    ...defaultInput,
    trustedApprover: scenario.approver ?? defaultInput.trustedApprover,
    ...scenario.input,
  };
  const triggering = runSpec({
    id: input.upstreamRunId ?? 101,
    attempt: input.upstreamRunAttempt ?? 1,
    headSha: input.upstreamHeadSha ?? HEAD,
    ...scenario.triggering,
  });
  const push = runSpec({
    id: 202,
    attempt: 1,
    event: "push",
    createdAt: "2026-10-17T00:00:00Z",
    pullRequests: [],
    ...scenario.push,
  });
  const listed = scenario.listedRuns ?? [push, triggering];
  const pulls = scenario.pulls ?? [pullSpec()];
  const revision = scenario.revision ?? 1;
  const issue = scenario.issue ?? 12;
  const approvalId = scenario.approvalId ?? 9001;
  const issueComments = scenario.issueComments === null
    ? []
    : scenario.issueComments ?? [
      ...(scenario.plan === false ? [] : [{ id: 8000, body: planBody(revision, issue), login: "planner-synthetic" }]),
      ...(scenario.approval === false
        ? []
        : [{ id: approvalId, body: `APPROVED plan v${revision}`, login: scenario.approvalAuthor ?? "kenny-synthetic" }]),
    ];
  const checkRuns = scenario.checkRuns ?? [
    { id: 301, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
    { id: 302, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
  ];
  const calls: string[] = [];
  const client: GitHubClient = {
    async get(requestPath: string) {
      calls.push(requestPath);
      if (requestPath === `/repos/${FULL}`) {
        return response(scenario.repoStatus ?? 200, { id: REPO_ID, full_name: FULL });
      }
      if (requestPath === `/repos/${FULL}/actions/runs/${triggering.id}`) {
        return response(scenario.runStatus ?? 200, toApiRun(triggering));
      }
      if (requestPath === `/repos/${FULL}/commits/${input.upstreamHeadSha}/pulls`) {
        return response(scenario.pullsStatus ?? 200, pulls.map(toApiPull));
      }
      const pullMatch = requestPath.match(/\/pulls\/(\d+)$/);
      if (pullMatch?.[1]) {
        if (scenario.fullPull === null) {
          return response(404, { message: "missing" });
        }
        const number = Number(pullMatch[1]);
        const found = pulls.find((pull) => pull.number === number) ?? pulls[0];
        if (!found) {
          return response(404, { message: "missing" });
        }
        return response(200, toApiPull({ ...found, ...scenario.fullPull }));
      }
      if (requestPath === `/repos/${FULL}/actions/workflows/checks.yml/runs?head_sha=${input.upstreamHeadSha}&per_page=100`) {
        return response(scenario.listStatus ?? 200, { workflow_runs: listed.map(toApiRun) });
      }
      if (requestPath === `/repos/${FULL}/commits/${input.upstreamHeadSha}/check-runs?per_page=100`) {
        return response(scenario.checksStatus ?? 200, { check_runs: checkRuns });
      }
      const commentMatch = requestPath.match(/\/issues\/(\d+)\/comments\?per_page=100$/);
      if (commentMatch?.[1]) {
        const source = Number(commentMatch[1]);
        const comments = source === issue ? issueComments : scenario.prComments ?? [];
        return response(scenario.commentsStatus ?? 200, comments.map(toApiComment));
      }
      const priorMatch = requestPath.match(/\/actions\/runs\/(\d+)\/(approvals|jobs)$/);
      if (priorMatch?.[1] && priorMatch[2]) {
        const prior = scenario.prior?.[Number(priorMatch[1])];
        if (!prior) {
          throw new Error(`unexpected prior run request ${requestPath}`);
        }
        if (priorMatch[2] === "approvals") {
          return response(prior.approvalsStatus ?? 200, prior.approvals);
        }
        return response(prior.jobsStatus ?? 200, prior.jobs);
      }
      throw new Error(`unexpected path ${requestPath}`);
    },
  };
  const result = await resolveTrigger(client, input);
  return { result, calls, input };
}

function marker(over: Partial<Parameters<typeof dedupeMarker>[0]> = {}): string {
  return dedupeMarker({
    pr: 14,
    head: HEAD,
    revision: 1,
    approvalId: 9001,
    checks: "101:1,202:1",
    assessmentRunId: 555,
    ...over,
  });
}

function assertNoSentinel(text: string): void {
  assert.equal(text.includes(SENTINEL), false);
  assert.equal(text.includes(MESSAGE_SENTINEL), false);
  assert.equal(text.includes("ghp_"), false);
  assert.equal(text.includes("XAI_API_KEY"), false);
}

test("(a) Reject gate → rerun checks on unchanged candidate → no new automatic gate", async () => {
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 70, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: rejectedReview(), jobs: startedJobs() } },
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.proceed, false);
  assert.equal(result.postComment, false);
  assert.equal(result.marker, null);
  assert.equal(result.reason, CLOSED_GATE_REASON);
  assert.match(result.logLine, /decision=skip reason=prior gate rejected\/expired for this head and revision; recovery only/);
  assertNoSentinel(result.provenance);
});

test("(b) an expired gate closes the automatic path and a skip or defer run does not", async () => {
  const expired = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 71, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: [], jobs: expiredJobs() } },
  });
  assert.equal(expired.result.decision, "skip");
  assert.equal(expired.result.proceed, false);
  assert.equal(expired.result.postComment, false);
  assert.equal(expired.result.reason, CLOSED_GATE_REASON);
  assert.equal(classifyPriorRun([], expiredJobs()), "expired");

  const skipped = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 72, body: marker({ assessmentRunId: 556 }), login: "github-actions[bot]" }],
    prior: { 556: { approvals: [], jobs: skippedAssessJobs() } },
  });
  assert.equal(classifyPriorRun([], skippedAssessJobs()), "none");
  assert.equal(skipped.result.decision, "proceed");
  assert.equal(skipped.result.proceed, true);
  assert.notEqual(skipped.result.reason, CLOSED_GATE_REASON);

  const cancelledWithoutProceed = jobsOf(
    prepareJob(false),
    assessJob({ status: "completed", conclusion: "cancelled", started_at: null, steps: [], environment: { name: "grok-assessment" } }),
  );
  assert.equal(classifyPriorRun([], cancelledWithoutProceed), "none");
  const notExpired = await runScenario({
    input: { upstreamRunAttempt: 3 },
    triggering: { attempt: 3 },
    prComments: [{ id: 73, body: marker({ assessmentRunId: 557 }), login: "github-actions[bot]" }],
    prior: { 557: { approvals: [], jobs: cancelledWithoutProceed } },
  });
  assert.equal(notExpired.result.decision, "proceed");
  assert.equal(notExpired.result.reason, "required checks completed");
});

test("(b) a gate cancelled while waiting counts as expired", async () => {
  const waitingCancel = jobsOf(
    prepareJob(true),
    assessJob({
      status: "completed",
      conclusion: "cancelled",
      started_at: null,
      steps: [],
      environment: { name: "grok-assessment" },
    }),
  );
  assert.equal(classifyPriorRun([], waitingCancel), "expired");
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 74, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: [], jobs: waitingCancel } },
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.reason, CLOSED_GATE_REASON);
  assert.equal(result.proceed, false);
});

test("(c) a checks rerun with no prior rejected or expired gate proceeds as a fresh unit", async () => {
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2, conclusion: "success" },
    push: { conclusion: "success" },
    prComments: [{ id: 75, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: approvedReview(), jobs: startedJobs() } },
  });
  assert.equal(result.decision, "proceed");
  assert.equal(result.proceed, true);
  assert.equal(result.postComment, true);
  assert.equal(result.checkStatus, "success");
  assert.match(result.marker ?? "", /assessment_run=777/);
  assert.match(result.marker ?? "", /checks=101:2,202:1/);
});

test("(c) failure then success is a fresh unit when no gate was closed", async () => {
  const oldFailure = runSpec({
    id: 202,
    event: "push",
    attempt: 1,
    conclusion: "failure",
    createdAt: "2026-10-16T00:00:00Z",
    pullRequests: [],
  });
  const newSuccess = runSpec({
    id: 202,
    event: "push",
    attempt: 2,
    conclusion: "success",
    createdAt: "2026-10-17T00:00:00Z",
    pullRequests: [],
  });
  const triggering = runSpec({ id: 101, event: "pull_request", conclusion: "success" });
  const { result } = await runScenario({
    triggering,
    listedRuns: [oldFailure, newSuccess, triggering],
  });
  assert.equal(result.decision, "proceed");
  assert.equal(result.checkStatus, "success");
  assert.match(result.marker ?? "", /checks=101:1,202:2/);
});

test("(d) after a rejected gate, a new head or a new plan revision proceeds", async () => {
  const newHead = await runScenario({
    prComments: [{ id: 76, body: marker({ head: OTHER_HEAD }), login: "github-actions[bot]" }],
  });
  assert.equal(newHead.result.decision, "proceed");
  assert.equal(newHead.result.headSha, HEAD);
  assert.equal(newHead.calls.some((call) => call.includes("/approvals")), false);

  const newRevision = await runScenario({
    revision: 2,
    approvalId: 9002,
    prComments: [{ id: 77, body: marker({ revision: 1, approvalId: 9001 }), login: "github-actions[bot]" }],
  });
  assert.equal(newRevision.result.decision, "proceed");
  assert.equal(newRevision.result.planRevision, 2);
  assert.equal(newRevision.calls.some((call) => call.includes("/approvals")), false);
});

test("(d) a re-posted approval of the same revision does not reopen a rejected gate", async () => {
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 4 },
    triggering: { attempt: 4 },
    approvalId: 9002,
    prComments: [{ id: 78, body: marker({ approvalId: 9001 }), login: "github-actions[bot]" }],
    prior: { 555: { approvals: rejectedReview(), jobs: startedJobs() } },
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.reason, CLOSED_GATE_REASON);
  assert.equal(result.proceed, false);
  assert.equal(result.postComment, false);
});

test("(e) recovery dispatch after a rejected gate is not blocked", async () => {
  const { result, calls } = await runScenario({
    input: {
      eventName: "workflow_dispatch",
      prNumber: 14,
      expectedHeadSha: HEAD,
      upstreamRunId: undefined,
      upstreamRunAttempt: undefined,
      upstreamHeadSha: undefined,
    },
    prComments: [{ id: 79, body: marker(), login: "github-actions[bot]" }],
  });
  assert.equal(result.decision, "proceed");
  assert.equal(result.proceed, true);
  assert.equal(result.triggerMode, "recovery workflow_dispatch");
  assert.equal(result.reason, "recovery dispatch");
  assert.match(result.logLine, /Trigger mode: recovery workflow_dispatch/);
  assert.equal(calls.some((call) => call.includes("/approvals") || call.includes("/jobs")), false);
  assert.equal(result.prNumber, 14);
  assert.equal(result.headSha, HEAD);
});

test("(f) approvals or jobs API unavailable gives SKIP", async () => {
  const approvalsDown = await runScenario({
    prComments: [{ id: 80, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: rejectedReview(), jobs: startedJobs(), approvalsStatus: 503 } },
  });
  assert.equal(approvalsDown.result.decision, "skip");
  assert.equal(approvalsDown.result.proceed, false);
  assert.equal(approvalsDown.result.postComment, false);
  assert.equal(approvalsDown.result.reason, API_UNAVAILABLE_REASON);

  const jobsDown = await runScenario({
    prComments: [{ id: 81, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: [], jobs: expiredJobs(), jobsStatus: 500 } },
  });
  assert.equal(jobsDown.result.decision, "skip");
  assert.equal(jobsDown.result.reason, API_UNAVAILABLE_REASON);
  assert.equal(jobsDown.result.proceed, false);
});

test("(g) an action_required conclusion proceeds with check status failure, so CHECK-01 applies", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required"]) {
    const { result } = await runScenario({ triggering: { conclusion } });
    assert.equal(result.decision, "proceed", conclusion);
    assert.equal(result.proceed, true, conclusion);
    assert.equal(result.checkStatus, "failure", conclusion);
  }
  const checkOnly = await runScenario({
    checkRuns: [
      { id: 301, name: "secret-free checks", status: "completed", conclusion: "action_required", head_sha: HEAD },
      { id: 302, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
    ],
  });
  assert.equal(checkOnly.result.decision, "proceed");
  assert.equal(checkOnly.result.checkStatus, "failure");
  const mapped = mapCheckRuns(
    { check_runs: [{ name: "secret-free checks", conclusion: "action_required", status: "completed" }] },
    HEAD,
  );
  assert.equal(mapped.required[0]?.conclusion, "failure");
  const findings = readFileSync(path.join(repoRoot, "src/risk-assessor/findings.ts"), "utf8");
  assert.match(findings, /checkState === "failure"/);
  assert.match(findings, /CHECK-01/);
  const existing = readFileSync(path.join(repoRoot, "tests/risk-assessor.test.ts"), "utf8");
  assert.match(existing, /a failed required check is NO-GO for CHECK-01/);
});

test("criterion 1 resolves an eligible PR on success and records main as the assessor", async () => {
  const { result, calls } = await runScenario();
  assert.equal(result.decision, "proceed");
  assert.equal(result.proceed, true);
  assert.equal(result.postComment, true);
  assert.equal(result.prNumber, 14);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.assessorSha, ASSESSOR);
  assert.notEqual(result.assessorSha, result.headSha);
  assert.equal(result.planRevision, 1);
  assert.equal(result.checkStatus, "success");
  assert.equal(result.triggerMode, "workflow_run");
  assert.match(result.logLine, new RegExp(`Trigger mode: workflow_run; upstream run \\d+/\\d+ .*; PR #14; head ${HEAD}; assessor ${ASSESSOR}; plan rev 1; decision=proceed`));
  assert.match(result.provenance, /Trigger mode: workflow_run/);
  assert.match(result.provenance, /101\/1 pull_request success/);
  assert.match(result.provenance, /202\/1 push success/);
  assert.match(result.provenance, new RegExp(`Head: ${HEAD}`));
  assert.match(result.provenance, new RegExp(`Base: ${BASE}`));
  assert.match(result.provenance, new RegExp(`Assessor commit: ${ASSESSOR}`));
  assert.equal(calls.some((call) => call.includes("/pulls/999")), false);
  assert.equal(calls.some((call) => call.endsWith(`/commits/${HEAD}/pulls`)), true);
  assertNoSentinel(result.logLine);
  assertNoSentinel(result.provenance);
  assertNoSentinel(result.marker ?? "");
});

test("criterion 3 skipped, neutral, stale, and startup_failure skip as check evidence incomplete", async () => {
  for (const conclusion of ["skipped", "neutral", "stale", "startup_failure"]) {
    const { result } = await runScenario({ triggering: { conclusion } });
    assert.equal(result.decision, "skip", conclusion);
    assert.equal(result.proceed, false, conclusion);
    assert.equal(result.postComment, false, conclusion);
    assert.equal(result.reason, CHECKS_INCOMPLETE_REASON, conclusion);
    assert.equal(result.checkStatus, "incomplete", conclusion);
  }
  const checkRun = await runScenario({
    checkRuns: [
      { id: 301, name: "secret-free checks", status: "completed", conclusion: "neutral", head_sha: HEAD },
      { id: 302, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
    ],
  });
  assert.equal(checkRun.result.decision, "skip");
  assert.equal(checkRun.result.reason, CHECKS_INCOMPLETE_REASON);
});

test("criterion 4 and 5 defer until both push and pull_request runs have completed, in either order", async () => {
  const pushFirst = await runScenario({ push: { status: "in_progress", conclusion: null } });
  assert.equal(pushFirst.result.decision, "defer");
  assert.equal(pushFirst.result.reason, CHECKS_PENDING_REASON);
  assert.equal(pushFirst.result.proceed, false);
  assert.equal(pushFirst.result.postComment, false);
  assert.equal(pushFirst.result.checkStatus, "pending");

  const pullRequestRun = runSpec({ id: 303, event: "pull_request", status: "in_progress", conclusion: null, createdAt: "2026-10-18T00:06:00Z" });
  const pushTrigger = runSpec({ id: 202, event: "push", conclusion: "success", createdAt: "2026-10-17T00:00:00Z", pullRequests: [] });
  const prFirst = await runScenario({
    input: { upstreamRunId: 202, upstreamRunAttempt: 1 },
    triggering: pushTrigger,
    listedRuns: [pushTrigger, pullRequestRun],
  });
  assert.equal(prFirst.result.decision, "defer");
  assert.equal(prFirst.result.reason, CHECKS_PENDING_REASON);

  const later = await runScenario();
  assert.equal(later.result.decision, "proceed");

  const checkPending = await runScenario({
    checkRuns: [
      { id: 301, name: "secret-free checks", status: "in_progress", conclusion: null, head_sha: HEAD },
      { id: 302, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
    ],
  });
  assert.equal(checkPending.result.decision, "defer");
  assert.equal(checkPending.result.reason, CHECKS_PENDING_REASON);
});

test("criterion 6 an existing prepared unit skips as a duplicate", async () => {
  const { result } = await runScenario({
    prComments: [{ id: 82, body: marker({ checks: "202:1,101:1", assessmentRunId: 555 }), login: "github-actions[bot]" }],
    prior: { 555: { approvals: approvedReview(), jobs: startedJobs() } },
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.proceed, false);
  assert.equal(result.postComment, false);
  assert.equal(result.reason, "duplicate of run 555");
  assert.match(result.logLine, /decision=skip reason=duplicate of run 555/);
  assert.equal(canonicalChecks([{ id: 202, attempt: 1 }, { id: 101, attempt: 1 }]), "101:1,202:1");
});

test("criterion 6 a gate still waiting skips as gate already open", async () => {
  const waiting = jobsOf(
    prepareJob(true),
    assessJob({ status: "waiting", conclusion: null, started_at: null, steps: [], environment: { name: "grok-assessment" } }),
  );
  assert.equal(classifyPriorRun([], waiting), "waiting");
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 83, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: [], jobs: waiting } },
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.reason, GATE_OPEN_REASON);
  assert.equal(result.proceed, false);
  assert.notEqual(result.reason, CLOSED_GATE_REASON);
});

test("criterion 8 manual recovery keeps dispatch validation and is not deduplicated", async () => {
  const { result } = await runScenario({
    input: {
      eventName: "workflow_dispatch",
      prNumber: 14,
      expectedHeadSha: HEAD,
      upstreamRunId: undefined,
      upstreamRunAttempt: undefined,
      upstreamHeadSha: undefined,
    },
    prComments: [{ id: 84, body: marker(), login: "github-actions[bot]" }],
    prior: { 555: { approvals: approvedReview(), jobs: startedJobs() } },
  });
  assert.equal(result.decision, "proceed");
  assert.equal(result.triggerMode, "recovery workflow_dispatch");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pr_number:/);
  assert.match(workflow, /expected_head_sha:/);
  assert.match(workflow, /RECOVERY \(PR/);
  assert.match(workflow, /AUTO \(/);

  const badSha = await runScenario({
    input: {
      eventName: "workflow_dispatch",
      prNumber: 14,
      expectedHeadSha: "not-a-sha",
      upstreamRunId: undefined,
      upstreamRunAttempt: undefined,
      upstreamHeadSha: undefined,
    },
  });
  assert.equal(badSha.result.decision, "failed");
  assert.equal(badSha.result.proceed, false);
  assert.equal(badSha.result.reason, "expected_head_sha must be 40 hexadecimal characters");

  const badPr = await runScenario({
    input: {
      eventName: "workflow_dispatch",
      prNumber: 0,
      expectedHeadSha: HEAD,
      upstreamRunId: undefined,
      upstreamRunAttempt: undefined,
      upstreamHeadSha: undefined,
    },
  });
  assert.equal(badPr.result.decision, "failed");
  assert.equal(badPr.result.reason, "pr_number must be a positive integer");

  const missingPlan = await runScenario({
    input: {
      eventName: "workflow_dispatch",
      prNumber: 14,
      expectedHeadSha: HEAD,
      upstreamRunId: undefined,
      upstreamRunAttempt: undefined,
      upstreamHeadSha: undefined,
    },
    plan: false,
    approval: false,
  });
  assert.equal(missingPlan.result.decision, "proceed");
  assert.equal(missingPlan.result.reason, "recovery dispatch");
  assert.equal(missingPlan.result.planRevision, null);
});

test("criterion 9 never reads pull_requests[0] and resolves a missing or empty array through the API", async () => {
  const missing = await runScenario({ triggering: { pullRequests: undefined } });
  assert.equal(missing.result.decision, "proceed");
  assert.equal(missing.result.prNumber, 14);
  assert.equal(missing.calls.some((call) => call.includes("/pulls/999")), false);

  const empty = await runScenario({ triggering: { pullRequests: [] } });
  assert.equal(empty.result.decision, "proceed");
  assert.equal(empty.result.prNumber, 14);

  const forkStyleEmpty = await runScenario({
    triggering: { pullRequests: [] },
    pulls: [],
  });
  assert.equal(forkStyleEmpty.result.decision, "skip");
  assert.equal(forkStyleEmpty.result.reason, "none");
  assert.equal(forkStyleEmpty.result.proceed, false);
  assert.equal(forkStyleEmpty.result.postComment, false);
});

test("criterion 10 skips ineligible upstream runs and pull requests", async () => {
  const cases: { name: string; scenario: Scenario; reason: string }[] = [
    {
      name: "several PRs",
      scenario: { pulls: [pullSpec({ number: 14 }), pullSpec({ number: 15 })] },
      reason: "ambiguous",
    },
    { name: "no PR", scenario: { pulls: [] }, reason: "none" },
    {
      name: "main push",
      scenario: { triggering: { event: "push", headBranch: "main" }, input: { upstreamRunId: 101 } },
      reason: "main push",
    },
    { name: "closed", scenario: { pulls: [pullSpec({ state: "closed" })] }, reason: "closed" },
    { name: "merged", scenario: { pulls: [pullSpec({ state: "closed", mergedAt: "2026-10-18T00:00:00Z" })] }, reason: "merged" },
    {
      name: "fork run",
      scenario: { triggering: { fork: true, headRepoFullName: "fork/other", headRepoId: 9 } },
      reason: "fork",
    },
    {
      name: "fork PR",
      scenario: { pulls: [pullSpec({ headFork: true, headRepo: "fork/other" })] },
      reason: "fork",
    },
    {
      name: "wrong repo",
      scenario: { triggering: { repoId: 9, repoFullName: "other/repo" } },
      reason: "wrong repo",
    },
    {
      name: "wrong path",
      scenario: { triggering: { path: ".github/workflows/other.yml", name: "checks" } },
      reason: "wrong workflow path",
    },
  ];
  for (const item of cases) {
    const { result } = await runScenario(item.scenario);
    assert.equal(result.decision, "skip", item.name);
    assert.equal(result.reason, item.reason, item.name);
    assert.equal(result.proceed, false, item.name);
    assert.equal(result.postComment, false, item.name);
  }

  const mismatch = await runScenario({ triggering: { headSha: OTHER_HEAD } });
  assert.equal(mismatch.result.reason, "payload/API mismatch");
  assert.equal(mismatch.result.proceed, false);
});

test("criterion 11 a draft pull request stays eligible", async () => {
  const { result } = await runScenario({ pulls: [pullSpec({ draft: true })] });
  assert.equal(result.decision, "proceed");
  assert.equal(result.prNumber, 14);
  assert.doesNotMatch(workflow, /gh pr ready/);
  assert.doesNotMatch(workflow, /gh pr merge/);
});

test("criterion 12 a head that moved before prepare is a stale-head skip", async () => {
  const { result } = await runScenario({ pulls: [pullSpec({ headSha: OTHER_HEAD })] });
  assert.equal(result.decision, "skip");
  assert.equal(result.reason, "stale head");
  assert.equal(result.proceed, false);
  assert.equal(result.postComment, false);
  const collect = readFileSync(path.join(repoRoot, "src/risk-assessor/collect.ts"), "utf8");
  assert.match(collect, /pull request head does not match the expected SHA/);
});

test("criterion 13 and 14 keep the post-wait recheck for head, plan, and approval", () => {
  assert.match(workflow, /cli\.ts recheck/);
  assert.match(workflow, /steps\.recheck\.outcome == 'failure'/);
  assert.match(workflow, /Write a report without the model when the head changed/);
  assert.match(workflow, /pull request head does not match the expected SHA|recorded assessor commit does not match/);
  const existing = readFileSync(path.join(repoRoot, "tests/risk-assessor.test.ts"), "utf8");
  assert.match(existing, /stale head is HUMAN and does not call the model/);
  assert.match(existing, /recheck rejects a plan that no longer matches the preserved input/);
  assert.match(existing, /a changed plan is stale and does not call the model/);
});

test("criterion 15 a missing plan or approval skips with a step summary and no comment", async () => {
  const noPlan = await runScenario({ plan: false, approval: false });
  assert.equal(noPlan.result.decision, "skip");
  assert.equal(noPlan.result.reason, PLAN_MISSING_REASON);
  assert.equal(noPlan.result.postComment, false);
  assert.equal(noPlan.result.proceed, false);

  const wrongAuthor = await runScenario({ approvalAuthor: "someone-else" });
  assert.equal(wrongAuthor.result.decision, "skip");
  assert.equal(wrongAuthor.result.reason, PLAN_MISSING_REASON);

  const maintenanceOnly = await runScenario({
    issueComments: [{
      id: 1,
      body: "## Maintenance plan revision 2\n\nThis is not an ordinary plan.",
      login: "planner-synthetic",
    }],
  });
  assert.equal(maintenanceOnly.result.reason, PLAN_MISSING_REASON);

  const existing = readFileSync(path.join(repoRoot, "tests/risk-assessor.test.ts"), "utf8");
  assert.match(existing, /a missing plan does not call the model/);
});

test("criterion 16 ignores markers that are not from github-actions[bot]", async () => {
  const { result, calls } = await runScenario({
    prComments: [{ id: 85, body: marker(), login: "kenny-synthetic" }],
  });
  assert.equal(result.decision, "proceed");
  assert.equal(calls.some((call) => call.includes("/approvals")), false);
});

test("criterion 16 a malformed bot marker fails closed", async () => {
  const { result } = await runScenario({
    prComments: [{ id: 86, body: "<!-- risk-assessment-dedupe this is not parseable -->", login: "github-actions[bot]" }],
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.reason, API_UNAVAILABLE_REASON);
  assert.equal(result.proceed, false);
});

test("criterion 17 and 18 keep the existing API-failure and approval-identity behavior", () => {
  const existing = readFileSync(path.join(repoRoot, "tests/risk-assessor.test.ts"), "utf8");
  assert.match(existing, /API failure is HUMAN with incomplete and null risk/);
  assert.match(existing, /blocker plus API failure stays NO-GO and keeps IAM-02/);
  assert.match(existing, /a forged self-asserted approver does not authorize the plan/);
  assert.match(existing, /an empty trusted approver does not authorize the plan/);
  const collect = readFileSync(path.join(repoRoot, "src/risk-assessor/collect.ts"), "utf8");
  assert.match(collect, /trustedApprover/);
});

test("criterion 19 assess downloads only this run's assessment-inputs artifact", () => {
  assert.match(workflow, /download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333/);
  assert.doesNotMatch(workflow, /run-id/);
  assert.doesNotMatch(workflow, /github-token/);
  const downloads = workflow.match(/uses: actions\/download-artifact@/g) ?? [];
  assert.equal(downloads.length, 2);
});

test("criterion 20 the published comment path is unchanged", () => {
  assert.match(workflow, /cli\.ts comment-file/);
  assert.match(workflow, /needs\.assess\.result == 'success'/);
  const cli = readFileSync(path.join(repoRoot, "src/risk-assessor/cli.ts"), "utf8");
  assert.match(cli, /- Decision: \$\{diagnostics\.decision/);
});

test("criterion 21 provenance is visible without a payload or a secret", async () => {
  const { result } = await runScenario();
  assert.match(result.provenance, /## Trigger provenance/);
  assert.match(result.provenance, /Decision: proceed/);
  assert.match(result.provenance, /Reason: required checks completed/);
  assert.match(result.provenance, /Plan revision: 1/);
  assertNoSentinel(result.provenance);
  const outputs: Record<string, string> = {};
  let summary = "";
  let annotation = "";
  const code = await executeTriggerCli({
    env: {
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_REPOSITORY: FULL,
      ASSESSOR_SHA: ASSESSOR,
      ASSESSMENT_RUN_ID: "777",
      ASSESSMENT_APPROVER: "kenny-synthetic",
      UPSTREAM_RUN_ID: "101",
      UPSTREAM_RUN_ATTEMPT: "1",
      UPSTREAM_HEAD_SHA: HEAD,
    },
    client: (await clientForScenario()),
    writeOutput: (name, value) => {
      outputs[name] = value;
    },
    writeSummary: (text) => {
      summary = text;
    },
    writeAnnotation: (text) => {
      annotation = text;
    },
    sleep: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(outputs.decision, "proceed");
  assert.equal(outputs.proceed, "true");
  assert.equal(outputs.pr_number, "14");
  assert.equal(outputs.expected_head_sha, HEAD);
  assert.equal(outputs.base_sha, BASE);
  assert.equal(outputs.plan_revision, "1");
  assert.equal(outputs.trigger_mode, "workflow_run");
  assert.match(outputs.upstream_runs ?? "", /101\/1/);
  assert.match(summary, /Trigger mode: workflow_run/);
  assert.match(annotation, /risk-assessment-dedupe/);
  assertNoSentinel(summary);
});

test("criterion 22 eval stays a non-zero pending command", () => {
  const pending = readFileSync(path.join(repoRoot, "scripts/eval-pending.ts"), "utf8");
  assert.match(pending, /process\.exit\(1\)/);
  assert.match(pending, /PENDING: live API evaluation has not been run/);
  const packageJson = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  assert.match(packageJson, /"eval": "tsx scripts\/eval-pending\.ts"/);
});

test("T1 every checkout uses the trusted SHA and does not check out the candidate", () => {
  const blocks = workflow.split("uses: actions/checkout@").slice(1);
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    const body = block.split("\n      - ")[0] ?? block;
    assert.match(body, /persist-credentials:\s*false/);
    assert.match(body, /ref: \$\{\{ (steps\.trusted\.outputs\.trusted_sha|needs\.prepare\.outputs\.trusted_sha) \}\}/);
    assert.doesNotMatch(body, /workflow_run\.head_sha/);
    assert.doesNotMatch(body, /head_branch/);
  }
  assert.doesNotMatch(workflow, /npm install/);
  assert.match(workflow, /npm ci/);
});

test("T2 the API key stays on the trusted assessor step only", () => {
  const matches = workflow.match(/secrets\.XAI_API_KEY/g) ?? [];
  assert.equal(matches.length, 1);
  const step = workflow.slice(workflow.indexOf("name: Run the trusted assessor"), workflow.indexOf("name: Upload risk report"));
  assert.match(step, /XAI_API_KEY: \$\{\{ secrets\.XAI_API_KEY \}\}/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit/);
  const prepare = jobSection(workflow, "prepare");
  const publish = jobSection(workflow, "publish");
  assert.doesNotMatch(prepare, /XAI_API_KEY/);
  assert.doesNotMatch(publish, /XAI_API_KEY/);
});

test("T3 every action pin is a full SHA recorded on main", () => {
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] ?? "");
  assert.ok(uses.length >= 8);
  const expected = new Set([
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  ]);
  for (const use of uses) {
    assert.match(use, /@[0-9a-f]{40}$/);
    assert.equal(expected.has(use), true, use);
  }
});

test("T4 permissions stay explicit and prepare's actions read is the only addition", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  const prepare = jobSection(workflow, "prepare");
  const assess = jobSection(workflow, "assess");
  const publish = jobSection(workflow, "publish");
  assert.match(prepare, /actions:\s*read/);
  assert.match(prepare, /contents:\s*read/);
  assert.match(prepare, /pull-requests:\s*write/);
  assert.match(prepare, /checks:\s*read/);
  assert.match(assess, /contents:\s*read/);
  assert.match(assess, /pull-requests:\s*read/);
  assert.match(assess, /checks:\s*read/);
  const assessPermissions = assess.slice(assess.indexOf("permissions:"), assess.indexOf("\n    steps:"));
  assert.doesNotMatch(assessPermissions, /actions:/);
  assert.doesNotMatch(assessPermissions, /write/);
  assert.match(publish, /actions:\s*read/);
  assert.match(publish, /pull-requests:\s*write/);
});

test("T5 run scripts do not interpolate event text", () => {
  for (const body of runBodies(workflow)) {
    assert.doesNotMatch(body, /\$\{\{/);
  }
  assert.doesNotMatch(workflow, /head_branch/);
  assert.doesNotMatch(workflow, /display_title/);
  assert.doesNotMatch(workflow, /head_commit/);
  assert.match(workflow, /pr_number must be a positive integer/);
  assert.match(workflow, /expected_head_sha must be 40 hexadecimal characters/);
  assert.match(workflow, /PR_NUMBER: \$\{\{ steps\.resolve\.outputs\.pr_number \}\}/);
  assert.match(workflow, /EXPECTED_HEAD_SHA: \$\{\{ steps\.resolve\.outputs\.expected_head_sha \}\}/);
});

test("T6 npm ci uses the trusted checkout and the key-bearing jobs have no npm cache", () => {
  assert.doesNotMatch(workflow, /cache:\s*npm/);
  assert.doesNotMatch(workflow, /run-id/);
  const prepare = jobSection(workflow, "prepare");
  assert.match(prepare, /ref: \$\{\{ steps\.trusted\.outputs\.trusted_sha \}\}/);
  assert.match(prepare, /npm ci/);
});

test("T7 the main-ref guard, assessor SHA check, environment, and recheck stay", () => {
  const guards = workflow.match(/refs\/heads\/main/g) ?? [];
  assert.ok(guards.length >= 3);
  assert.match(workflow, /GITHUB_SHA" != "\$TRUSTED_SHA"/);
  assert.match(workflow, /environment:\s*grok-assessment/);
  assert.match(workflow, /cli\.ts recheck/);
  assert.match(workflow, /if: needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.decision == 'proceed'/);
});

test("T8 skip and defer do not reach the environment job", () => {
  const assess = jobSection(workflow, "assess");
  assert.match(assess, /environment:\s*grok-assessment/);
  assert.match(assess, /needs\.prepare\.outputs\.decision == 'proceed'/);
  assert.match(workflow, /proceed: \$\{\{ steps\.resolve\.outputs\.proceed \}\}/);
  const beforeJobs = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  assert.doesNotMatch(beforeJobs, /concurrency:/);
  const assessAndPublish = `${jobSection(workflow, "assess")}\n${jobSection(workflow, "publish")}`;
  assert.doesNotMatch(assessAndPublish, /concurrency:/);
  assert.match(jobSection(workflow, "prepare"), /concurrency:/);
  assert.match(workflow, /risk-assessment-prepare-/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
  const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.match(onBlock, /workflows:\s*\[checks\]/);
  assert.match(onBlock, /types:\s*\[completed\]/);
  assert.doesNotMatch(onBlock, /conclusion/);
  assert.match(workflow, /cat trigger-annotation\.md >> pre-approval\.md/);
});

test("API lag re-reads about three times ten seconds apart, then skips", async () => {
  assert.equal(API_LAG_REREADS, 3);
  assert.equal(API_LAG_DELAY_MS, 10_000);
  const sleeps: number[] = [];
  let calls = 0;
  const client: GitHubClient = {
    async get() {
      calls += 1;
      return response(404, { message: "missing" });
    },
  };
  const result = await resolveTriggerWithReread(client, defaultInput, async (ms) => {
    sleeps.push(ms);
  });
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  assert.equal(result.decision, "skip");
  assert.equal(result.proceed, false);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, UPSTREAM_NOT_VISIBLE_REASON);
  assert.ok(calls >= 4);

  let attempts = 0;
  const flaky = await clientForScenario();
  const wrapped: GitHubClient = {
    async get(requestPath: string) {
      if (requestPath === `/repos/${FULL}/actions/runs/101` && attempts === 0) {
        attempts += 1;
        return response(404, { message: "lag" });
      }
      return flaky.get(requestPath);
    },
  };
  const visible = await resolveTriggerWithReread(wrapped, defaultInput, async () => {});
  assert.equal(visible.decision, "proceed");
  assert.equal(attempts, 1);
});

test("the hidden marker round-trips and a rejection of another environment does not close the gate", async () => {
  const text = marker();
  assert.deepEqual(parseDedupeMarker(text), {
    pr: 14,
    head: HEAD,
    revision: 1,
    approvalId: 9001,
    checks: "101:1,202:1",
    assessmentRunId: 555,
  });
  const { result } = await runScenario({
    input: { upstreamRunAttempt: 2 },
    triggering: { attempt: 2 },
    prComments: [{ id: 87, body: marker(), login: "github-actions[bot]" }],
    prior: {
      555: {
        approvals: [{ state: "rejected", environments: [{ name: "production" }] }],
        jobs: startedJobs(),
      },
    },
  });
  assert.equal(result.decision, "proceed");
  assert.notEqual(result.reason, CLOSED_GATE_REASON);
});

test("README line 34 and AGENTS line 41 state the automatic trigger", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8").split("\n");
  const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8").split("\n");
  const sentence = "Assessment normally starts automatically after checks, and manual dispatch is recovery.";
  assert.equal(readme[33]?.startsWith(sentence), true);
  assert.equal(agents[40]?.endsWith(sentence), true);
});

function jobSection(source: string, job: string): string {
  const token = `\n  ${job}:\n`;
  const start = source.indexOf(token);
  assert.ok(start >= 0, job);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function runBodies(source: string): string[] {
  const lines = source.split("\n");
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^(\s*)run:\s*(.*)$/);
    if (!match?.[1] || match[2] === undefined) {
      continue;
    }
    const indent = match[1].length;
    const rest = match[2];
    if (rest === "|" || rest === ">") {
      const body: string[] = [];
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const line = lines[inner] ?? "";
        if (line.trim() === "") {
          body.push(line);
          continue;
        }
        const lineIndent = line.match(/^ */)?.[0].length ?? 0;
        if (lineIndent <= indent) {
          break;
        }
        body.push(line);
      }
      bodies.push(body.join("\n"));
    } else {
      bodies.push(rest);
    }
  }
  return bodies;
}

async function clientForScenario(): Promise<GitHubClient> {
  const captured: { client?: GitHubClient } = {};
  const input = defaultInput;
  const triggering = runSpec();
  const push = runSpec({ id: 202, event: "push", createdAt: "2026-10-17T00:00:00Z", pullRequests: [] });
  const pulls = [pullSpec()];
  const issueComments = [
    { id: 8000, body: planBody(1, 12), login: "planner-synthetic" },
    { id: 9001, body: "APPROVED plan v1", login: "kenny-synthetic" },
  ];
  const checkRuns = [
    { id: 301, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
    { id: 302, name: "secret-free checks", status: "completed", conclusion: "success", head_sha: HEAD },
  ];
  captured.client = {
    async get(requestPath: string) {
      if (requestPath === `/repos/${FULL}`) {
        return response(200, { id: REPO_ID, full_name: FULL });
      }
      if (requestPath === `/repos/${FULL}/actions/runs/${triggering.id}`) {
        return response(200, toApiRun(triggering));
      }
      if (requestPath === `/repos/${FULL}/commits/${input.upstreamHeadSha}/pulls`) {
        return response(200, pulls.map(toApiPull));
      }
      if (requestPath === `/repos/${FULL}/pulls/14`) {
        return response(200, toApiPull(pulls[0] as PullSpec));
      }
      if (requestPath === `/repos/${FULL}/actions/workflows/checks.yml/runs?head_sha=${HEAD}&per_page=100`) {
        return response(200, { workflow_runs: [push, triggering].map(toApiRun) });
      }
      if (requestPath === `/repos/${FULL}/commits/${HEAD}/check-runs?per_page=100`) {
        return response(200, { check_runs: checkRuns });
      }
      if (requestPath === `/repos/${FULL}/issues/14/comments?per_page=100`) {
        return response(200, []);
      }
      if (requestPath === `/repos/${FULL}/issues/12/comments?per_page=100`) {
        return response(200, issueComments.map(toApiComment));
      }
      throw new Error(`unexpected path ${requestPath}`);
    },
  };
  return captured.client;
}
