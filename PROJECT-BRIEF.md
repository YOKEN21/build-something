# Grok Bot release readiness — project brief

Updated: 15 October 2026.

**Status:** design selected; repository and initial account connections established. The application workflow is not yet verified end to end. See [PROJECT-PLAN.md](PROJECT-PLAN.md) for the build sequence, contracts, bot responsibilities, capability checks and demo runbook.

These documents describe the intended system. They do not authorize an agent to implement the entire plan. Each task specifies one work package, allowed changes, acceptance criteria and a stopping point.

## Outcome

Build a lead Grok Bot and three specialist Grok Bots that take a developer's change request from "I need X" to a risk-scored pull request that a human decides to merge or not. Bots clarify requirements directly with each other. A GitHub Issue records the request, the versioned plan and the human approvals. One specialist delegates the implementation to a Cursor cloud agent guided by Kenny-authored repository rules and skills.

The Grok API is called by a **release-risk assessor** that Cursor builds. It reads the approved request, the pull request diff and the check results, and returns a structured risk report. The Assurance bot acts on that report. Assessment runs in GitHub Actions after human approval for a specific candidate commit. Synthetic infrastructure files are never deployed.

## Selected architecture

| Area | Kenny's selection |
| --- | --- |
| Problem space | Software delivery and release readiness |
| Business workflow | Change request → clarification → approved plan → Cursor PR → risk assessment → GO / NO-GO / HUMAN → human decision |
| Record of truth | GitHub Issue (request, plan versions, approvals) and the PR |
| Bot coordination | Direct native Grok Bot handoffs in one group; the Lead mirrors outcomes to the Issue |
| Bots | Release Lead; Developer Liaison, Platform Engineer, Assurance Reviewer |
| Coding agent | Cursor cloud agent, dispatched by the Platform Engineer |
| Grok API use | Release-risk assessor: structured JSON risk report the bots act on |
| Where code runs | GitHub Actions on GitHub-hosted runners, public repository; no containers, no AWS |
| Human steps | Approve plan revision; approve the key-bearing assessment job; merge |
| Repository | `YOKEN21/build-something`; original project code and synthetic examples |

Keep this brief and the plan at the repository root so the bots and Cursor share the same versioned context. Use original code and synthetic data; exclude private source code, customer material, credentials and private correspondence.

## Why this fits

The enterprise problem is that go/no-go on platform changes depends on a senior engineer reading the ticket, the diff and the CI output by hand. It is slow, inconsistent, and the evidence is scattered. The system makes the evidence structured and the decision visible while leaving the decision with a human.

Four bots exist because each owns one thing: the status board, the developer, the repo, or the evidence. Bots clarify directly because that is faster than a ticket round trip, but only a versioned plan and a human approval authorize work, so a conversation cannot negotiate a requirement away. The judge is the risk assessor on protected `main`, never the version inside the PR, so a change cannot grade itself.

## Capability checks

Reuse the existing setup and inspect completed runs before creating new ones. Record evidence for capabilities that have not yet been verified.

1. Grok Bot reads a GitHub Issue, comments on it, and reads a PR's checks and artifacts through the GitHub connector.
2. The Platform bot launches a Cursor cloud agent against the personal repository and recovers the PR.
3. Four bots in one group; one specialist asks another a question and receives the answer.
4. A public repository with a protected environment: a test job waits, Kenny's approval releases a dummy value.
5. One Grok API structured-output call returns the expected schema on an accessible model.
6. Connector and Cursor identities are verified separately from the human approver, with repository and environment permissions tested.

Verify environment approval support for the repository's GitHub plan and configure the assessment environment to allow only `main`. Track Grok API usage, Cursor usage and any runner costs separately; do not assume every account or runner is free. See [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) and [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Demo finish line

Show the live trigger, a specialist-to-specialist clarification, the approved plan on the Issue, the Cursor handoff and its PR, the trusted assessor run with the Grok call site open, the structured risk report, Assurance's recommendation and the human merge decision. Open each bot's skills, routine, connectors, memory and voice configuration, plus the repository rules, skills and workflows. Prepare two slides and one rehearsed live change, with a second ready.

Claim only what runs: a PR-stage release-readiness system. The existing CI/CD attaches after merge as it does today.
