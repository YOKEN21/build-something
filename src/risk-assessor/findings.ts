import path from "node:path";
import { cpuMemoryError, exceedsPreferredSize, isValidCpuMemory } from "../checks/cpu-memory";
import { releaseRuleProblems } from "../checks/rules";
import { filesOutsideAllowedPaths, toPosix } from "../checks/scope";
import { readJson, validateInstance } from "../checks/schema";
import { parseCatalog, type AuthorizationRecord, type ParsedCatalog } from "./catalog";
import {
  RULE_IDS,
  isSha,
  type AssessmentInput,
  type ApprovalInput,
  type ChangeType,
  type CheckConclusion,
  type DiffFile,
  type Evidence,
  type PlanInput,
  type RiskLevel,
  type RuleId,
} from "./types";

const serviceConfigSchema = readJson(path.join(__dirname, "../../contracts/service-config.schema.json")) as object;
const taskRoleSchema = readJson(path.join(__dirname, "../../contracts/task-roles.schema.json")) as object;

const BLOCKING = new Set<RuleId>([
  "IAM-02",
  "IAM-03",
  "IAM-04",
  "NET-01",
  "SCOPE-01",
  "SELF-01",
  "CHECK-01",
]);

const PROTECTED_PREFIXES = [".github/", "src/risk-assessor/", "policy/", "eval/"];
const SYNTHETIC_ACCOUNT = "111111111111";
const SENSITIVE_ACTION = /^(iam|kms|sts):/i;
const SERVICE_CONFIG_PATH = /^services\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/config\.json$/;
const TASK_ROLE_PATH = /^iam\/[a-z0-9]+(?:-[a-z0-9]+)*-task-roles\.json$/;

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export type Analysis = {
  identityOk: boolean;
  problems: string[];
  stale: boolean;
  headMoved: boolean;
  skipModel: boolean;
  rules: RuleId[];
  evidence: Evidence[];
  blocking: boolean;
  needsHuman: boolean;
  unresolvedAuthorization: boolean;
  authorizationEstablished: boolean;
  scopeOk: boolean;
  checksPassing: boolean;
  approvalValid: boolean;
  riskFloor: RiskLevel;
  humanCauses: string[];
};

type Statement = {
  effect: "Allow" | "Deny";
  actions: string[];
  resources: string[];
};

type RoleDocument = {
  account: string;
  roles: {
    name: string;
    service: string;
    environment: "dev" | "prod";
    statements: Statement[];
  }[];
};

type ConfigDocument = {
  service: string;
  environment: "dev" | "prod";
  account: string;
  owner: string;
  cpu: number;
  memory: number;
  publicEndpoint: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    return undefined;
  }
  return value;
}

function parseStatement(value: unknown): Statement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (Object.keys(value).some((key) => !["sid", "effect", "actions", "resources"].includes(key))) {
    return undefined;
  }
  const actions = stringArray(value.actions);
  const resources = stringArray(value.resources);
  if (typeof value.sid !== "string" || (value.effect !== "Allow" && value.effect !== "Deny") || !actions || !resources) {
    return undefined;
  }
  return { effect: value.effect, actions, resources };
}

function parseRoleDocument(value: unknown): RoleDocument | undefined {
  if (!isRecord(value) || typeof value.account !== "string" || !Array.isArray(value.roles)) {
    return undefined;
  }
  if (Object.keys(value).some((key) => !["account", "roles"].includes(key))) {
    return undefined;
  }
  const roles: RoleDocument["roles"] = [];
  for (const role of value.roles) {
    if (!isRecord(role)) {
      return undefined;
    }
    if (Object.keys(role).some((key) => !["name", "service", "product", "environment", "statements"].includes(key))) {
      return undefined;
    }
    if (
      typeof role.name !== "string" ||
      typeof role.service !== "string" ||
      typeof role.product !== "string" ||
      (role.environment !== "dev" && role.environment !== "prod") ||
      !Array.isArray(role.statements)
    ) {
      return undefined;
    }
    const statements: Statement[] = [];
    for (const statement of role.statements) {
      const parsed = parseStatement(statement);
      if (!parsed) {
        return undefined;
      }
      statements.push(parsed);
    }
    roles.push({
      name: role.name,
      service: role.service,
      environment: role.environment,
      statements,
    });
  }
  return { account: value.account, roles };
}

function parseConfigDocument(value: unknown): ConfigDocument | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const required = ["product", "service", "environment", "account", "owner", "cpu", "memory", "desiredCount", "publicEndpoint"];
  if (Object.keys(value).some((key) => !required.includes(key))) {
    return undefined;
  }
  if (
    typeof value.service !== "string" ||
    (value.environment !== "dev" && value.environment !== "prod") ||
    typeof value.account !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.cpu !== "number" ||
    typeof value.memory !== "number" ||
    typeof value.publicEndpoint !== "boolean" ||
    typeof value.product !== "string" ||
    typeof value.desiredCount !== "number"
  ) {
    return undefined;
  }
  return {
    service: value.service,
    environment: value.environment,
    account: value.account,
    owner: value.owner,
    cpu: value.cpu,
    memory: value.memory,
    publicEndpoint: value.publicEndpoint,
  };
}

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function parseApprovalRevision(body: string): number | undefined {
  const match = body.trim().match(/^APPROVED plan v([1-9][0-9]*)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]);
}

export function approvalMatches(approval: ApprovalInput, revision: number, authoritativeIssue?: number): boolean {
  if (approval.trusted_approver.trim().length === 0 || approval.author !== approval.trusted_approver) {
    return false;
  }
  if (parseApprovalRevision(approval.body) !== revision) {
    return false;
  }
  if (authoritativeIssue !== undefined && approval.source_issue !== authoritativeIssue) {
    return false;
  }
  return true;
}

function planRecord(plan: PlanInput): Record<string, unknown> {
  return {
    issue: plan.issue,
    change_type: plan.change_type,
    summary: plan.summary,
    product: plan.product,
    service: plan.service,
    environment: plan.environment,
    allowed_paths: plan.allowed_paths,
    plan_revision: plan.revision,
    acceptance_expectation: plan.acceptance_expectation,
  };
}

function quoteFor(file: DiffFile, needles: string[]): Evidence | undefined {
  const sources = [file.patch, file.before ?? "", file.after ?? ""];
  for (const needle of needles) {
    if (needle.length === 0 || needle.length > 240) {
      continue;
    }
    if (sources.some((source) => source.includes(needle))) {
      return { file: toPosix(file.path), quote: needle };
    }
  }
  return undefined;
}

function addRule(rules: RuleId[], rule: RuleId): void {
  if (!rules.includes(rule)) {
    rules.push(rule);
  }
}

export function planNamesBucketAndPrefix(plan: PlanInput, bucket: string, prefix: string): boolean {
  const text = `${plan.summary}\n${plan.acceptance_expectation}`;
  const prefixPattern = prefix.endsWith("/") ? `${prefix.slice(0, -1)}/*` : prefix;
  return text.includes(bucket) && (text.includes(prefix) || text.includes(prefixPattern));
}

function arnAccount(resource: string): string | undefined {
  const match = resource.match(/^arn:[^:]*:[^:]*:[^:]*:(\d{12}):/);
  return match?.[1];
}

function prefixWildcard(resource: string): { bucket: string; prefix: string } | undefined {
  const match = resource.match(/^arn:aws:s3:::([a-z0-9.-]+)\/([A-Za-z0-9._-]+)\/\*$/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { bucket: match[1], prefix: `${match[2]}/` };
}

function floorFor(rule: RuleId): RiskLevel {
  if (rule === "IAM-02" || rule === "IAM-03" || rule === "IAM-04" || rule === "ENV-01" || rule === "NET-01") {
    return "high";
  }
  return "medium";
}

function levelFromEffect(effect: string): RiskLevel {
  const text = effect.toLowerCase();
  if (/\bhigh\b/.test(text)) {
    return "high";
  }
  if (/\bmedium\b/.test(text)) {
    return "medium";
  }
  if (/\blow\b/.test(text)) {
    return "low";
  }
  return "medium";
}

/** Floors come from the trusted policy effect text. A model cannot lower them. */
export function policyRiskFloor(policy: unknown, rules: readonly RuleId[], changeType: ChangeType | undefined): RiskLevel {
  const effects = new Map<string, string>();
  if (isRecord(policy) && Array.isArray(policy.rules)) {
    for (const entry of policy.rules) {
      if (isRecord(entry) && typeof entry.id === "string" && typeof entry.effect === "string") {
        effects.set(entry.id, entry.effect);
      }
    }
  }
  return rules.reduce((floor, rule) => {
    const effect = effects.get(rule);
    return maxRisk(floor, effect === undefined ? floorFor(rule) : levelFromEffect(effect));
  }, changeFloor(changeType));
}

export function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function changeFloor(changeType: ChangeType | undefined): RiskLevel {
  return changeType === "config-change" ? "low" : "medium";
}

function publicIpv4(text: string): boolean {
  const pattern = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
  for (const match of text.matchAll(pattern)) {
    const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      continue;
    }
    const [a, b] = octets;
    if (a === undefined || b === undefined) {
      continue;
    }
    const privateAddress =
      a === 10 ||
      a === 0 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254);
    if (!privateAddress) {
      return true;
    }
  }
  return false;
}

function serviceOwner(catalog: ParsedCatalog, service: string, configOwner: string | undefined): string | undefined {
  if (configOwner) {
    return configOwner;
  }
  return catalog.serviceOwners.find((entry) => entry.service === service)?.owner;
}

function resourceForArn(catalog: ParsedCatalog, arnOrBucket: string): { owner: string; account: string; bucket: string } | undefined {
  const resource = catalog.resources.find(
    (entry) => entry.arn === arnOrBucket || entry.name === arnOrBucket || arnOrBucket.startsWith(`${entry.arn}/`),
  );
  if (!resource) {
    return undefined;
  }
  return { owner: resource.owner, account: resource.account, bucket: resource.name };
}

function sameAccount(record: AuthorizationRecord, account: string, resourceAccount: string): boolean {
  if (record.sameAccountOnly) {
    return account === resourceAccount && account === SYNTHETIC_ACCOUNT;
  }
  return record.account === account && account === resourceAccount;
}

function statementWithinScope(record: AuthorizationRecord, statement: Statement, plan: PlanInput): boolean {
  const scope = record.scope;
  if (statement.actions.length === 0 || statement.resources.length === 0) {
    return false;
  }
  if (!planNamesBucketAndPrefix(plan, scope.bucket, scope.prefix)) {
    return false;
  }
  const keyPrefix = `arn:aws:s3:::${scope.bucket}/${scope.prefix}`;
  for (const action of statement.actions) {
    const bucketAction = scope.bucketActions.includes(action);
    const objectAction = scope.objectActions.includes(action);
    if (bucketAction === objectAction) {
      return false;
    }
    for (const resource of statement.resources) {
      if (bucketAction) {
        if (resource !== scope.bucketArn) {
          return false;
        }
        continue;
      }
      const exactObject = resource === scope.objectResource;
      const specificKey = resource.startsWith(keyPrefix) && !resource.slice(keyPrefix.length).includes("*");
      if (!exactObject && !specificKey) {
        return false;
      }
    }
  }
  return true;
}

function grantWithinRecord(record: AuthorizationRecord, statements: Statement[], plan: PlanInput): boolean {
  const allows = statements.filter((statement) => statement.effect === "Allow");
  if (allows.length === 0) {
    return false;
  }
  return allows.every((statement) => statementWithinScope(record, statement, plan));
}

type IamOutcome = {
  rules: RuleId[];
  evidence: Evidence[];
  unresolved: boolean;
  authorized: boolean;
  ambiguous: boolean;
  hasAllow: boolean;
  schemaOk: boolean;
};

function assessIamFile(
  file: DiffFile,
  catalog: ParsedCatalog,
  plan: PlanInput,
  configOwner: string | undefined,
): IamOutcome {
  const parsed = parseJson(file.after);
  if (!parsed.ok) {
    return { rules: [], evidence: [], unresolved: false, authorized: false, ambiguous: true, hasAllow: false, schemaOk: false };
  }
  const document = parseRoleDocument(parsed.value);
  if (!document) {
    return { rules: [], evidence: [], unresolved: false, authorized: false, ambiguous: true, hasAllow: false, schemaOk: false };
  }
  const schemaOk = validateInstance(taskRoleSchema, parsed.value).ok;
  const rules: RuleId[] = [];
  const evidence: Evidence[] = [];
  let unresolved = false;
  let authorized = true;
  let hasAllow = false;
  for (const role of document.roles) {
    if (role.environment === "prod") {
      addRule(rules, "ENV-01");
      const quote = quoteFor(file, ['"environment": "prod"', "prod"]);
      if (quote) {
        evidence.push(quote);
      }
    }
    if (document.account !== SYNTHETIC_ACCOUNT) {
      addRule(rules, "IAM-04");
      const quote = quoteFor(file, [document.account]);
      if (quote) {
        evidence.push(quote);
      }
    }
    const allows: Statement[] = [];
    for (const statement of role.statements) {
      if (statement.effect !== "Allow") {
        continue;
      }
      allows.push(statement);
      hasAllow = true;
      for (const action of statement.actions) {
        if (SENSITIVE_ACTION.test(action)) {
          addRule(rules, "IAM-03");
          const quote = quoteFor(file, [action]);
          if (quote) {
            evidence.push(quote);
          }
        }
        if (action.includes("*")) {
          addRule(rules, "IAM-02");
          const quote = quoteFor(file, [action]);
          if (quote) {
            evidence.push(quote);
          }
        }
      }
      for (const resource of statement.resources) {
        const account = arnAccount(resource);
        if (account !== undefined && account !== SYNTHETIC_ACCOUNT) {
          addRule(rules, "IAM-04");
          const quote = quoteFor(file, [account, resource]);
          if (quote) {
            evidence.push(quote);
          }
        }
        if (resource === "*" || resource.endsWith(":*") || resource === "arn:aws:s3:::*") {
          addRule(rules, "IAM-02");
          const quote = quoteFor(file, [resource]);
          if (quote) {
            evidence.push(quote);
          }
          continue;
        }
        const wildcard = prefixWildcard(resource);
        if (resource.endsWith("/*") && wildcard === undefined) {
          addRule(rules, "IAM-02");
          const quote = quoteFor(file, [resource]);
          if (quote) {
            evidence.push(quote);
          }
          continue;
        }
        if (wildcard) {
          const catalogMatch = catalog.authorizations.some(
            (record) => record.scope.bucket === wildcard.bucket && record.scope.prefix === wildcard.prefix,
          );
          const planMatch = planNamesBucketAndPrefix(plan, wildcard.bucket, wildcard.prefix);
          if (!catalogMatch || !planMatch) {
            addRule(rules, "IAM-02");
            const quote = quoteFor(file, [resource]);
            if (quote) {
              evidence.push(quote);
            }
          }
        }
      }
    }
    if (allows.length === 0) {
      continue;
    }
    const owner = serviceOwner(catalog, role.service, configOwner);
    const resourceAccounts = new Set<string>();
    let sawResource = false;
    let missingOwner = false;
    for (const statement of allows) {
      for (const resource of statement.resources) {
        const starResource = resource === "*" || (resource.includes("*") && prefixWildcard(resource) === undefined && !resource.startsWith("arn:aws:s3:::"));
        if (starResource) {
          continue;
        }
        const bucket = resource.startsWith("arn:aws:s3:::") ? resource.slice("arn:aws:s3:::".length).split("/")[0] : undefined;
        if (!bucket) {
          continue;
        }
        sawResource = true;
        const known = resourceForArn(catalog, `arn:aws:s3:::${bucket}`);
        if (!known) {
          missingOwner = true;
          continue;
        }
        resourceAccounts.add(known.account);
        if (owner === undefined) {
          missingOwner = true;
        }
      }
    }
    if (missingOwner) {
      unresolved = true;
      authorized = false;
      addRule(rules, "IAM-01");
    }
    const resourceAccount = resourceAccounts.size === 1 ? [...resourceAccounts][0] : undefined;
    if (sawResource && resourceAccount === undefined && !missingOwner) {
      unresolved = true;
      authorized = false;
    }
    if (rules.includes("IAM-02") || rules.includes("IAM-03") || rules.includes("IAM-04")) {
      authorized = false;
    }
    if (!sawResource || missingOwner || resourceAccount === undefined) {
      continue;
    }
    const matching = catalog.authorizations.filter((record) => {
      return (
        record.consumer === role.service &&
        record.environment === role.environment &&
        sameAccount(record, document.account, resourceAccount) &&
        grantWithinRecord(record, allows, plan)
      );
    });
    if (matching.length !== 1) {
      unresolved = true;
      authorized = false;
      if (!rules.includes("IAM-02") && !rules.includes("IAM-03") && !rules.includes("IAM-04")) {
        addRule(rules, "IAM-01");
      }
      continue;
    }
    const matched = matching[0];
    if (!matched) {
      unresolved = true;
      authorized = false;
      continue;
    }
    const crossTeam = owner !== undefined && catalog.resources.some((resource) => {
      return allows.some((statement) =>
        statement.resources.some((item) => item === resource.arn || item.startsWith(`${resource.arn}/`)),
      ) && resource.owner !== owner;
    });
    if (owner === undefined) {
      unresolved = true;
      authorized = false;
      addRule(rules, "IAM-01");
      continue;
    }
    if (crossTeam && matched.access.includes("read")) {
      addRule(rules, "IAM-01");
      const quote = quoteFor(file, [matched.scope.objectResource, matched.scope.bucketArn, "s3:GetObject", "s3:ListBucket"]);
      if (quote) {
        evidence.push(quote);
      }
    }
  }
  if (unresolved || rules.includes("IAM-02") || rules.includes("IAM-03") || rules.includes("IAM-04")) {
    authorized = false;
  }
  return { rules, evidence, unresolved, authorized, ambiguous: false, hasAllow, schemaOk };
}

function assessConfigFile(file: DiffFile): {
  rules: RuleId[];
  evidence: Evidence[];
  ambiguous: boolean;
  owner?: string;
  schemaOk: boolean;
  invalidSize: boolean;
} {
  const parsed = parseJson(file.after);
  if (!parsed.ok) {
    return { rules: [], evidence: [], ambiguous: true, schemaOk: false, invalidSize: false };
  }
  const config = parseConfigDocument(parsed.value);
  if (!config) {
    return { rules: [], evidence: [], ambiguous: true, schemaOk: false, invalidSize: false };
  }
  const schemaOk = validateInstance(serviceConfigSchema, parsed.value).ok;
  const invalidSize = cpuMemoryError(config.cpu, config.memory) !== undefined;
  const rules: RuleId[] = [];
  const evidence: Evidence[] = [];
  if (config.environment === "prod") {
    addRule(rules, "ENV-01");
    const quote = quoteFor(file, ['"environment": "prod"']);
    if (quote) {
      evidence.push(quote);
    }
  }
  if (config.account !== SYNTHETIC_ACCOUNT) {
    addRule(rules, "IAM-04");
    const quote = quoteFor(file, [config.account]);
    if (quote) {
      evidence.push(quote);
    }
  }
  if (config.publicEndpoint || publicIpv4(file.after ?? "")) {
    addRule(rules, "NET-01");
    const quote = quoteFor(file, ['"publicEndpoint": true']);
    if (quote) {
      evidence.push(quote);
    }
  }
  if (isValidCpuMemory(config.cpu, config.memory) && exceedsPreferredSize(config.cpu, config.memory)) {
    addRule(rules, "SIZE-01");
    const quote = quoteFor(file, [`"cpu": ${config.cpu}`, `"memory": ${config.memory}`]);
    if (quote) {
      evidence.push(quote);
    }
  }
  return { rules, evidence, ambiguous: false, owner: config.owner, schemaOk, invalidSize };
}

function checksState(input: AssessmentInput): "missing" | "stale" | "pending" | "failure" | "success" {
  const checks = input.checks;
  if (!checks || !Array.isArray(checks.required)) {
    return "missing";
  }
  if (!isSha(checks.head_sha) || checks.head_sha !== input.head_sha) {
    return "stale";
  }
  if (checks.required.length === 0) {
    return "missing";
  }
  const conclusions: CheckConclusion[] = checks.required.map((check) => check.conclusion);
  if (conclusions.some((conclusion) => conclusion === "failure" || conclusion === "cancelled")) {
    return "failure";
  }
  if (conclusions.every((conclusion) => conclusion === "success")) {
    return "success";
  }
  return "pending";
}

function sortRules(rules: readonly RuleId[]): RuleId[] {
  return RULE_IDS.filter((id) => rules.includes(id));
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const result: Evidence[] = [];
  for (const item of evidence) {
    const key = `${item.file}\n${item.quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function analyze(input: AssessmentInput, changeRequestSchema: object): Analysis {
  const problems: string[] = [];
  const humanCauses: string[] = [];
  const identityOk =
    Number.isInteger(input.issue) &&
    input.issue >= 1 &&
    Number.isInteger(input.pr) &&
    input.pr >= 1 &&
    isSha(input.head_sha) &&
    isSha(input.base_sha) &&
    isSha(input.assessor_sha) &&
    input.plan !== null &&
    Number.isInteger(input.plan.revision) &&
    input.plan.revision >= 1;
  if (!Number.isInteger(input.issue) || input.issue < 1) {
    problems.push("issue is missing or invalid");
  }
  if (!Number.isInteger(input.pr) || input.pr < 1) {
    problems.push("pr is missing or invalid");
  }
  if (!isSha(input.head_sha)) {
    problems.push("head_sha is missing or invalid");
  }
  if (!isSha(input.base_sha)) {
    problems.push("base_sha is missing or invalid");
  }
  if (!isSha(input.assessor_sha)) {
    problems.push("assessor_sha is missing or invalid");
  }
  if (!isSha(input.current_head_sha)) {
    problems.push("current_head_sha is missing or invalid");
  }

  let planValid = false;
  if (input.plan === null) {
    problems.push("plan is missing");
  } else if (!Number.isInteger(input.plan.revision) || input.plan.revision < 1) {
    problems.push("plan revision is missing or invalid");
  } else {
    const planCheck = validateInstance(changeRequestSchema, planRecord(input.plan));
    if (!planCheck.ok || input.plan.issue !== input.issue || input.plan.author.trim().length === 0) {
      problems.push("plan is invalid");
    } else {
      planValid = true;
    }
  }

  const approvalValid =
    planValid &&
    input.plan !== null &&
    input.approval !== null &&
    approvalMatches(input.approval, input.plan.revision, input.plan.issue);
  if (!approvalValid) {
    problems.push("approval is missing or does not match the plan revision and trusted approver");
  }

  const policyProblems = isRecord(input.policy) && Array.isArray(input.policy.rules)
    ? releaseRuleProblems(input.policy.rules as { id?: string; rule?: string; effect?: string }[])
    : ["policy is missing or not an object"];
  const policyParsed = policyProblems.length === 0;
  if (!policyParsed) {
    problems.push("trusted policy cannot be parsed");
    humanCauses.push("unparsed_policy");
  }

  let catalog: ParsedCatalog | undefined;
  if (input.catalog_markdown === null || input.catalog_markdown.trim().length === 0) {
    problems.push("catalog is missing");
    humanCauses.push("unparsed_authorization");
  } else {
    const parsedCatalog = parseCatalog(input.catalog_markdown);
    if (!parsedCatalog.ok) {
      problems.push(parsedCatalog.reason);
      humanCauses.push("unparsed_authorization");
    } else {
      catalog = parsedCatalog.catalog;
    }
  }

  if (input.diff === null || !Array.isArray(input.diff.files)) {
    problems.push("diff is missing");
  }

  const headMoved = isSha(input.head_sha) && isSha(input.current_head_sha) && input.current_head_sha !== input.head_sha;
  const checkState = checksState(input);
  if (checkState === "missing") {
    problems.push("check results for the head SHA are missing");
  } else if (checkState === "stale") {
    problems.push("check results are not for the head SHA");
  } else if (checkState === "pending") {
    problems.push("check results for the head SHA are pending or unknown");
  }
  if (headMoved) {
    problems.push("current head does not match the assessed head");
    humanCauses.push("stale_head");
  }
  if (checkState === "stale" || input.inputs_match === false) {
    humanCauses.push("stale_evidence");
  }
  if (input.inputs_match === false) {
    problems.push("preserved plan or approval no longer matches the pull request");
  }

  const rules: RuleId[] = [];
  const evidence: Evidence[] = [];
  let unresolvedAuthorization = humanCauses.includes("unparsed_authorization");
  let ambiguous = false;
  let iamAuthorized = true;
  let sawAllow = false;

  const files = input.diff?.files ?? [];
  if (planValid && input.plan && input.diff) {
    const outside = filesOutsideAllowedPaths(files.map((file) => file.path), input.plan.allowed_paths);
    if (outside.length > 0) {
      addRule(rules, "SCOPE-01");
      for (const file of files) {
        if (!outside.includes(toPosix(file.path))) {
          continue;
        }
        const quote = quoteFor(file, [toPosix(file.path), file.after ?? "", file.patch]);
        if (quote) {
          evidence.push(quote);
        }
      }
    }
    for (const file of files) {
      const pathName = toPosix(file.path);
      const protectedFile = PROTECTED_PREFIXES.some((prefix) => pathName.startsWith(prefix));
      const named = input.plan.allowed_paths.map(toPosix).includes(pathName);
      if (protectedFile && !named) {
        addRule(rules, "SELF-01");
        const quote = quoteFor(file, [pathName]);
        if (quote) {
          evidence.push(quote);
        }
      }
    }
  }

  let configOwner: string | undefined;
  if (input.diff && catalog && input.plan && planValid) {
    for (const file of files) {
      const pathName = toPosix(file.path);
      if (SERVICE_CONFIG_PATH.test(pathName)) {
        const config = assessConfigFile(file);
        if (config.ambiguous) {
          ambiguous = true;
          problems.push(`config shape cannot be parsed: ${pathName}`);
        } else {
          configOwner = config.owner ?? configOwner;
          for (const rule of config.rules) {
            addRule(rules, rule);
          }
          evidence.push(...config.evidence);
          if (!config.schemaOk) {
            problems.push(`service config does not match its schema: ${pathName}`);
          }
          if (config.invalidSize) {
            problems.push(`invalid CPU/memory combination: ${pathName}`);
          }
        }
      }
    }
    for (const file of files) {
      const pathName = toPosix(file.path);
      if (!TASK_ROLE_PATH.test(pathName)) {
        continue;
      }
      const iam = assessIamFile(file, catalog, input.plan, configOwner);
      if (iam.ambiguous) {
        ambiguous = true;
        problems.push(`policy shape cannot be parsed: ${pathName}`);
        humanCauses.push("unparsed_policy");
      } else {
        sawAllow = sawAllow || iam.hasAllow;
        for (const rule of iam.rules) {
          addRule(rules, rule);
        }
        evidence.push(...iam.evidence);
        if (iam.unresolved) {
          unresolvedAuthorization = true;
        }
        if (!iam.authorized) {
          iamAuthorized = false;
        }
        if (!iam.schemaOk) {
          problems.push(`task role file does not match its schema: ${pathName}`);
        }
      }
    }
  } else if (input.diff && (!catalog || !planValid)) {
    iamAuthorized = false;
  }

  if (ambiguous) {
    humanCauses.push("unparsed_policy");
  }
  if (unresolvedAuthorization) {
    humanCauses.push("unresolved_authorization");
  }

  if (checkState === "failure" && !headMoved) {
    addRule(rules, "CHECK-01");
  }

  const sorted = sortRules(rules);
  const structuralIds = new Set<RuleId>(["SCOPE-01", "SELF-01"]);
  const reportStructural = policyParsed && !headMoved;
  // An unparseable file makes the assessment incomplete. It does not erase a blocker confirmed on another file.
  const reportContent = policyParsed && !headMoved;
  const reported = sortRules([
    ...(reportStructural ? sorted.filter((rule) => structuralIds.has(rule)) : []),
    ...(reportContent ? sorted.filter((rule) => !structuralIds.has(rule) && rule !== "CHECK-01") : []),
    ...(policyParsed && !headMoved && checkState === "failure" ? ["CHECK-01" as const] : []),
  ]);
  const blocking = reported.some((rule) => BLOCKING.has(rule));
  const needsHuman =
    unresolvedAuthorization ||
    reported.includes("ENV-01") ||
    ambiguous ||
    !policyParsed ||
    humanCauses.includes("unparsed_authorization");
  const stale = headMoved || checkState === "stale" || input.inputs_match === false;
  const checksPassing = checkState === "success";
  const authorizationEstablished =
    approvalValid &&
    catalog !== undefined &&
    !unresolvedAuthorization &&
    !ambiguous &&
    iamAuthorized &&
    (!sawAllow || !unresolvedAuthorization);
  const skipModel = problems.length > 0 || stale || ambiguous || !policyParsed || catalog === undefined;
  const riskFloor = riskFloorFor(reported, input.plan?.change_type);

  return {
    identityOk,
    problems,
    stale,
    headMoved,
    skipModel,
    rules: reported,
    evidence: dedupeEvidence(evidence),
    blocking,
    needsHuman,
    unresolvedAuthorization,
    authorizationEstablished,
    scopeOk: !reported.includes("SCOPE-01"),
    checksPassing,
    approvalValid,
    riskFloor,
    humanCauses: [...new Set(humanCauses)],
  };
}

export function riskFloorFor(rules: readonly RuleId[], changeType: ChangeType | undefined): RiskLevel {
  return rules.reduce<RiskLevel>((floor, rule) => maxRisk(floor, floorFor(rule)), changeFloor(changeType));
}
