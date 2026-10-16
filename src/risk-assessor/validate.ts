import { validateInstance } from "../checks/schema";
import { toPosix } from "../checks/scope";
import { unknownRuleIds } from "../checks/rules";
import { JUDGMENT_SCHEMA } from "./prompt";
import { RULE_IDS, isRuleId, type DiffFile, type Evidence, type RuleId } from "./types";

export type Judgment = {
  risk: "low" | "medium" | "high";
  rules_hit: RuleId[];
  evidence: Evidence[];
  needs_human: boolean;
  summary: string;
};

const KNOWN_RULES = new Set<string>(RULE_IDS);

export function quoteInDiff(files: readonly DiffFile[], file: string, quote: string): boolean {
  if (quote.length === 0) {
    return false;
  }
  const match = files.find((entry) => toPosix(entry.path) === toPosix(file));
  if (!match) {
    return false;
  }
  return [match.patch, match.before ?? "", match.after ?? ""].some((source) => source.includes(quote));
}

export function validateJudgment(
  content: unknown,
  files: readonly DiffFile[],
): { ok: true; judgment: Judgment } | { ok: false; reason: string } {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const rules = (content as { rules_hit?: unknown }).rules_hit;
    if (Array.isArray(rules) && rules.every((id) => typeof id === "string")) {
      const unknown = unknownRuleIds(rules, KNOWN_RULES);
      if (unknown.length > 0) {
        return { ok: false, reason: `rejected unknown rule id: ${unknown.join(", ")}` };
      }
    }
  }
  const schema = validateInstance(JUDGMENT_SCHEMA, content);
  if (!schema.ok) {
    return { ok: false, reason: `malformed model output: ${schema.errors.join("; ")}` };
  }
  const record = content as {
    risk: Judgment["risk"];
    rules_hit: string[];
    evidence: Evidence[];
    needs_human: boolean;
    summary: string;
  };
  if (!record.rules_hit.every((id) => isRuleId(id))) {
    return { ok: false, reason: "rejected unknown rule id" };
  }
  for (const item of record.evidence) {
    if (!quoteInDiff(files, item.file, item.quote)) {
      return { ok: false, reason: `evidence quote is not in the named diff file ${item.file}` };
    }
  }
  return {
    ok: true,
    judgment: {
      risk: record.risk,
      rules_hit: record.rules_hit,
      evidence: record.evidence,
      needs_human: record.needs_human,
      summary: record.summary,
    },
  };
}
