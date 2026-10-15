export const EXPECTED_RULES: readonly { id: string; rule: string; effect: string }[] = [
  {
    id: "IAM-01",
    rule: "Catalog-authorized read access to another team's resource in the same account",
    effect: "medium; missing owner or authorization evidence requires HUMAN",
  },
  {
    id: "IAM-02",
    rule: "Wildcard action, resource *, or resource pattern outside the catalog-approved scope",
    effect: "high, blocking",
  },
  {
    id: "IAM-03",
    rule: "iam:, kms: or sts: action",
    effect: "high, blocking",
  },
  {
    id: "IAM-04",
    rule: "Cross-account access",
    effect: "high, blocking",
  },
  {
    id: "ENV-01",
    rule: "Touches prod",
    effect: "high",
  },
  {
    id: "NET-01",
    rule: "Public endpoint or public IP",
    effect: "high, blocking",
  },
  {
    id: "SCOPE-01",
    rule: "Changed file outside allowed paths",
    effect: "blocking → NO-GO; correct the change or obtain approval for a revised plan",
  },
  {
    id: "SELF-01",
    rule: "Changes .github/, assessor, policy or eval without plan naming them",
    effect: "blocking → NO-GO; correct the change or obtain approval for a revised plan",
  },
  {
    id: "SIZE-01",
    rule: "Config change beyond catalog defaults",
    effect: "medium",
  },
  {
    id: "CHECK-01",
    rule: "Required checks for the candidate commit completed unsuccessfully",
    effect: "blocking",
  },
];

export function unknownRuleIds(rulesHit: readonly string[], knownIds: ReadonlySet<string>): string[] {
  return rulesHit.filter((id) => !knownIds.has(id));
}

export function releaseRuleProblems(
  rules: readonly { id?: string; rule?: string; effect?: string }[],
): string[] {
  const problems: string[] = [];
  if (rules.length !== EXPECTED_RULES.length) {
    problems.push(`expected ${EXPECTED_RULES.length} rules, found ${rules.length}`);
  }
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const expected = EXPECTED_RULES[index];
    if (!expected) {
      problems.push(`unexpected rule at index ${index}: ${rule.id ?? "(missing id)"}`);
      return;
    }
    if (rule.id !== expected.id) {
      problems.push(`index ${index} id ${rule.id ?? "(missing)"} does not match ${expected.id}`);
    }
    if (rule.rule !== expected.rule) {
      problems.push(`index ${index} rule text does not match ${expected.id}`);
    }
    if (rule.effect !== expected.effect) {
      problems.push(`index ${index} effect does not match ${expected.id}`);
    }
    if (rule.id !== undefined) {
      if (seen.has(rule.id)) {
        problems.push(`duplicate rule id ${rule.id}`);
      }
      seen.add(rule.id);
    }
  });
  return problems;
}
