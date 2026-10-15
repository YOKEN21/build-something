import path from "node:path";
import { readJson } from "../checks/schema";
import { validateInstance } from "../checks/schema";
import { decide } from "./decision";
import { analyze, maxRisk, policyRiskFloor } from "./findings";
import { JUDGMENT_SCHEMA, PROMPT_VERSION, buildPrompt } from "./prompt";
import type { AssessmentInput, AssessmentResult, Diagnostics, Evidence, ModelProvider, RiskReport, RuleId } from "./types";
import { RULE_IDS } from "./types";
import { quoteInDiff, validateJudgment } from "./validate";

const BLOCKING = new Set<RuleId>(["IAM-02", "IAM-03", "IAM-04", "NET-01", "SCOPE-01", "SELF-01", "CHECK-01"]);

const reportSchema = readJson(path.join(__dirname, "../../contracts/risk-report.schema.json")) as object;
const changeRequestSchema = readJson(path.join(__dirname, "../../contracts/change-request.schema.json")) as object;

function sortRules(rules: readonly RuleId[]): RuleId[] {
  return RULE_IDS.filter((id) => rules.includes(id));
}

function redact(text: string, secret: string | undefined): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join("[redacted]");
}

function supportedEvidence(input: AssessmentInput, evidence: Evidence[]): Evidence[] {
  const files = input.diff?.files ?? [];
  return evidence.filter((item) => quoteInDiff(files, item.file, item.quote));
}

function incompleteSummary(reasons: string[]): string {
  const detail = reasons.length > 0 ? reasons.join(" ") : "Required assessment input is missing or invalid.";
  return `Assessment incomplete. ${detail} This is not a successful assessment.`;
}

function baseReport(input: AssessmentInput, fields: Omit<RiskReport, "issue" | "pr" | "head_sha" | "base_sha" | "assessor_sha" | "plan_revision">): RiskReport {
  return {
    issue: input.issue,
    pr: input.pr,
    head_sha: input.head_sha,
    base_sha: input.base_sha,
    assessor_sha: input.assessor_sha,
    plan_revision: input.plan?.revision ?? 0,
    ...fields,
  };
}

export async function assess(
  input: AssessmentInput,
  options: { provider: ModelProvider; model: string; secret?: string; timeoutMs?: number },
): Promise<AssessmentResult> {
  const started = Date.now();
  const analysis = analyze(input, changeRequestSchema);
  const reasons = analysis.problems.slice();
  const humanCauses = analysis.humanCauses.slice();
  const diagnostics = (extra: Partial<Diagnostics> & Pick<Diagnostics, "decision" | "model_called" | "attempts" | "prompt_version" | "model">): Diagnostics => ({
    token_usage: null,
    duration_ms: Date.now() - started,
    reasons: reasons.map((reason) => redact(reason, options.secret)),
    human_causes: humanCauses,
    ...extra,
  });

  if (!analysis.identityOk || input.plan === null) {
    reasons.push("identity fields are incomplete, so no report was written");
    return {
      report: null,
      decision: "HUMAN",
      diagnostics: diagnostics({
        model: "not-called",
        prompt_version: "0",
        model_called: false,
        attempts: 0,
        decision: "HUMAN",
      }),
    };
  }

  const codeEvidence = supportedEvidence(input, analysis.evidence);
  if (analysis.skipModel) {
    const report = baseReport(input, {
      assessment_status: "incomplete",
      risk: null,
      blocking: analysis.blocking,
      needs_human: true,
      rules_hit: analysis.rules,
      evidence: codeEvidence,
      scope_ok: analysis.scopeOk,
      summary: redact(incompleteSummary(reasons), options.secret),
      model: "not-called",
      prompt_version: "0",
    });
    const schema = validateInstance(reportSchema, report);
    if (!schema.ok) {
      return {
        report: null,
        decision: "HUMAN",
        diagnostics: diagnostics({
          model: "not-called",
          prompt_version: "0",
          model_called: false,
          attempts: 0,
          decision: "HUMAN",
          reasons: [...reasons, ...schema.errors],
        }),
      };
    }
    const decision = decide({
      confirmedBlocking: report.blocking,
      assessmentIncomplete: true,
      stale: analysis.stale,
      unresolvedAuthorization: analysis.unresolvedAuthorization,
      highRisk: false,
      needsHuman: true,
      checksPassing: analysis.checksPassing,
      approvalValid: analysis.approvalValid,
      authorizationEstablished: analysis.authorizationEstablished,
      completeAndValid: false,
    });
    return {
      report,
      decision,
      diagnostics: diagnostics({
        model: "not-called",
        prompt_version: "0",
        model_called: false,
        attempts: 0,
        decision,
      }),
    };
  }

  const prompt = buildPrompt(input, analysis);
  const modelResult = await options.provider({
    model: options.model,
    promptVersion: PROMPT_VERSION,
    system: prompt.system,
    user: prompt.user,
    schema: JUDGMENT_SCHEMA,
    timeoutMs: options.timeoutMs ?? 900_000,
  });

  if (!modelResult.ok) {
    reasons.push(modelResult.reason);
    humanCauses.push("model_failure");
    const report = baseReport(input, {
      assessment_status: "incomplete",
      risk: null,
      blocking: analysis.blocking,
      needs_human: true,
      rules_hit: analysis.rules,
      evidence: codeEvidence,
      scope_ok: analysis.scopeOk,
      summary: redact(incompleteSummary([modelResult.reason]), options.secret),
      model: options.model,
      prompt_version: PROMPT_VERSION,
    });
    const decision = decide({
      confirmedBlocking: report.blocking,
      assessmentIncomplete: true,
      stale: analysis.stale,
      unresolvedAuthorization: analysis.unresolvedAuthorization,
      highRisk: false,
      needsHuman: true,
      checksPassing: analysis.checksPassing,
      approvalValid: analysis.approvalValid,
      authorizationEstablished: analysis.authorizationEstablished,
      completeAndValid: false,
    });
    return {
      report: schemaReport(report),
      decision,
      diagnostics: diagnostics({
        model: options.model,
        prompt_version: PROMPT_VERSION,
        model_called: true,
        attempts: modelResult.attempts,
        token_usage: modelResult.usage,
        decision,
      }),
    };
  }

  const judgment = validateJudgment(modelResult.content, input.diff?.files ?? []);
  if (!judgment.ok) {
    reasons.push(judgment.reason);
    humanCauses.push("rejected_model_output");
    const report = baseReport(input, {
      assessment_status: "incomplete",
      risk: null,
      blocking: analysis.blocking,
      needs_human: true,
      rules_hit: analysis.rules,
      evidence: codeEvidence,
      scope_ok: analysis.scopeOk,
      summary: redact(incompleteSummary([judgment.reason]), options.secret),
      model: options.model,
      prompt_version: PROMPT_VERSION,
    });
    const decision = decide({
      confirmedBlocking: report.blocking,
      assessmentIncomplete: true,
      stale: false,
      unresolvedAuthorization: analysis.unresolvedAuthorization,
      highRisk: false,
      needsHuman: true,
      checksPassing: analysis.checksPassing,
      approvalValid: analysis.approvalValid,
      authorizationEstablished: analysis.authorizationEstablished,
      completeAndValid: false,
    });
    return {
      report: schemaReport(report),
      decision,
      diagnostics: diagnostics({
        model: options.model,
        prompt_version: PROMPT_VERSION,
        model_called: true,
        attempts: modelResult.attempts,
        token_usage: modelResult.usage,
        decision,
      }),
    };
  }

  const modelOnlyBlocking = judgment.judgment.rules_hit.filter(
    (rule) => BLOCKING.has(rule) && !analysis.rules.includes(rule),
  );
  const rules = sortRules([...analysis.rules, ...judgment.judgment.rules_hit]);
  // Only deterministic code confirms a blocker. A model-only blocking rule stays unresolved.
  const blocking = analysis.blocking;
  let risk = maxRisk(policyRiskFloor(input.policy, rules, input.plan.change_type), judgment.judgment.risk);
  if (modelOnlyBlocking.length > 0) {
    humanCauses.push("model_only_blocker");
  }
  let needsHuman = analysis.needsHuman || judgment.judgment.needs_human || modelOnlyBlocking.length > 0;
  if (risk === "high" && !blocking) {
    needsHuman = true;
    humanCauses.push("high_risk");
  }
  const report = baseReport(input, {
    assessment_status: "complete",
    risk,
    blocking,
    needs_human: needsHuman,
    rules_hit: rules,
    evidence: supportedEvidence(input, [...codeEvidence, ...judgment.judgment.evidence]),
    scope_ok: analysis.scopeOk,
    summary: redact(judgment.judgment.summary, options.secret),
    model: options.model,
    prompt_version: PROMPT_VERSION,
  });
  const validated = validateInstance(reportSchema, report);
  if (!validated.ok) {
    reasons.push(...validated.errors);
    return {
      report: null,
      decision: "HUMAN",
      diagnostics: diagnostics({
        model: options.model,
        prompt_version: PROMPT_VERSION,
        model_called: true,
        attempts: modelResult.attempts,
        token_usage: modelResult.usage,
        decision: "HUMAN",
      }),
    };
  }
  const decision = decide({
    confirmedBlocking: blocking,
    assessmentIncomplete: false,
    stale: analysis.stale,
    unresolvedAuthorization: analysis.unresolvedAuthorization,
    highRisk: risk === "high",
    needsHuman,
    checksPassing: analysis.checksPassing,
    approvalValid: analysis.approvalValid,
    authorizationEstablished: analysis.authorizationEstablished,
    completeAndValid: true,
  });
  return {
    report,
    decision,
    diagnostics: diagnostics({
      model: options.model,
      prompt_version: PROMPT_VERSION,
      model_called: true,
      attempts: modelResult.attempts,
      token_usage: modelResult.usage,
      decision,
    }),
  };
}

function schemaReport(report: RiskReport): RiskReport | null {
  const validated = validateInstance(reportSchema, report);
  return validated.ok ? report : null;
}
