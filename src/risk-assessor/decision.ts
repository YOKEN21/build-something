import type { Decision } from "./types";

/**
 * Section 7 order:
 * 1. A confirmed blocking violation is NO-GO.
 * 2. Incomplete, stale, unresolved, high, or needs_human is HUMAN.
 * 3. GO only when every required condition holds.
 */
export type DecisionContext = {
  confirmedBlocking: boolean;
  assessmentIncomplete: boolean;
  stale: boolean;
  unresolvedAuthorization: boolean;
  highRisk: boolean;
  needsHuman: boolean;
  checksPassing: boolean;
  approvalValid: boolean;
  authorizationEstablished: boolean;
  completeAndValid: boolean;
};

export function decide(context: DecisionContext): Decision {
  if (context.confirmedBlocking) {
    return "NO-GO";
  }
  if (
    context.assessmentIncomplete ||
    context.stale ||
    context.unresolvedAuthorization ||
    context.highRisk ||
    context.needsHuman
  ) {
    return "HUMAN";
  }
  if (
    context.checksPassing &&
    context.approvalValid &&
    context.authorizationEstablished &&
    context.completeAndValid
  ) {
    return "GO";
  }
  return "HUMAN";
}
