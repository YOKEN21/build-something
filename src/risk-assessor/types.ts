export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const RULE_IDS = [
  "IAM-01",
  "IAM-02",
  "IAM-03",
  "IAM-04",
  "ENV-01",
  "NET-01",
  "SCOPE-01",
  "SELF-01",
  "SIZE-01",
  "CHECK-01",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export type ChangeType = "new-service" | "config-change" | "iam-permission-change";

export type RiskLevel = "low" | "medium" | "high";

export type Decision = "GO" | "NO-GO" | "HUMAN";

export type Evidence = {
  file: string;
  quote: string;
};

export type PlanInput = {
  issue: number;
  revision: number;
  change_type: ChangeType;
  summary: string;
  product: string;
  service: string;
  environment: "dev" | "prod";
  allowed_paths: string[];
  acceptance_expectation: string;
  author: string;
};

export type ApprovalInput = {
  author: string;
  body: string;
  trusted_approver: string;
  /** Issue or pull request whose comment thread contained this approval. */
  source_issue?: number;
};

export type DiffFile = {
  path: string;
  patch: string;
  before: string | null;
  after: string | null;
};

export type CheckConclusion =
  | "success"
  | "failure"
  | "pending"
  | "unknown"
  | "skipped"
  | "cancelled";

export type ChecksInput = {
  head_sha: string;
  required: { name: string; conclusion: CheckConclusion }[];
};

/**
 * Collected assessment inputs. Null fields are missing inputs.
 * PR text, when present, is untrusted data and is not an approval.
 */
export type AssessmentInput = {
  issue: number;
  pr: number;
  head_sha: string;
  base_sha: string;
  assessor_sha: string;
  current_head_sha: string;
  plan: PlanInput | null;
  approval: ApprovalInput | null;
  diff: { files: DiffFile[] } | null;
  catalog_markdown: string | null;
  checks: ChecksInput | null;
  policy: unknown;
  untrusted_pr_body: string | null;
  /** Login allowed to approve the plan. An empty string means no approval can match. */
  trusted_approver: string;
  /** False when a recheck finds the head, plan, or approval no longer match. */
  inputs_match?: boolean;
};

export type RiskReport = {
  issue: number;
  pr: number;
  head_sha: string;
  base_sha: string;
  assessor_sha: string;
  plan_revision: number;
  assessment_status: "complete" | "incomplete";
  risk: RiskLevel | null;
  blocking: boolean;
  needs_human: boolean;
  rules_hit: RuleId[];
  evidence: Evidence[];
  scope_ok: boolean;
  summary: string;
  model: string;
  prompt_version: string;
};

export type TokenUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
};

export type ModelRequest = {
  model: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: object;
  timeoutMs: number;
};

export type ModelResult =
  | { ok: true; content: unknown; attempts: number; usage: TokenUsage }
  | { ok: false; reason: string; attempts: number; usage: TokenUsage | null };

export type ModelProvider = (request: ModelRequest) => Promise<ModelResult>;

export type Diagnostics = {
  model: string;
  prompt_version: string;
  model_called: boolean;
  attempts: number;
  duration_ms: number;
  token_usage: TokenUsage | null;
  decision: Decision;
  reasons: string[];
  human_causes: string[];
};

export type AssessmentResult = {
  report: RiskReport | null;
  decision: Decision;
  diagnostics: Diagnostics;
};

export function isRuleId(value: string): value is RuleId {
  return (RULE_IDS as readonly string[]).includes(value);
}

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}
