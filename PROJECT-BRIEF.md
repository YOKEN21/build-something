# Grok Bot release readiness — agreed brief

Updated: 15 October 2026. Interview target: Wednesday 21 or Thursday 22 October.

**Status:** design selected; implementation has not started. See [PROJECT-PLAN.md](PROJECT-PLAN.md) for the build sequence, contracts, bot responsibilities, gates and interview runbook.

## Outcome

Build a lead Grok Bot and three specialist Grok Bots that take a developer's change request from "I need X" to a risk-scored pull request that a human decides to merge or not. Bots clarify requirements directly with each other. A GitHub Issue records the request, the versioned plan and the human approvals. One specialist delegates the implementation to a Cursor cloud agent guided by Kenny-authored repository rules and skills.

The Grok API is called by a **release-risk assessor** that Cursor builds. It reads the approved request, the pull request diff and the check results, and returns a structured risk report. The Assurance bot acts on that report. The assessor runs inside GitHub Actions on every candidate PR; nothing is deployed anywhere.

## Selected architecture

| Area | Kenny's selection |
| --- | --- |
| Problem space | Space 1: software delivery and release readiness |
| Business workflow | Change request → clarification → approved plan → Cursor PR → risk assessment → go/no-go → human merge |
| Record of truth | GitHub Issue (request, plan versions, approvals) and the PR |
| Bot coordination | Direct native Grok Bot handoffs in one group; the Lead mirrors outcomes to the Issue |
| Bots | Release Lead; Developer Liaison, Platform Engineer, Assurance Reviewer |
| Coding agent | Cursor cloud agent, dispatched by the Platform Engineer |
| Grok API use | Release-risk assessor: structured JSON risk report the bots act on |
| Where code runs | GitHub Actions on GitHub-hosted runners, public repository; no containers, no AWS |
| Human steps | Approve plan revision; approve the key-bearing assessment job; merge |
| Demo environment | Personal computer at home; personal GitHub; existing Grok Bot, Cursor and Grok API accounts |

The local planning folder is `workshops-samples/kenny-devops-agent`. Its internal GitLab remote is not the Cursor execution target. Create an original personal GitHub repository at home; do not mirror internal source, customer screenshots or meeting material.

## Why this fits

The enterprise problem is that go/no-go on platform changes depends on a senior engineer reading the ticket, the diff and the CI output by hand. It is slow, inconsistent, and the evidence is scattered. The system makes the evidence structured and the decision visible while leaving the decision with a human.

Four bots exist because each owns one thing: the status board, the developer, the repo, or the evidence. Bots clarify directly because that is faster than a ticket round trip, but only a versioned plan and a human approval authorize work, so a conversation cannot negotiate a requirement away. The judge is the risk assessor on protected `main`, never the version inside the PR, so a change cannot grade itself.

## First prerequisites at home

1. Grok Bot reads a GitHub Issue, comments on it, and reads a PR's checks and artifacts through the GitHub connector.
2. The Platform bot launches a Cursor cloud agent against the personal repository and recovers the PR.
3. Four bots in one group; one specialist asks another a question and receives the answer.
4. A public repository with a protected environment: a test job waits, Kenny's approval releases a dummy value.
5. One Grok API structured-output call returns the expected schema on an accessible model.

GitHub's required environment reviewers are limited to public repositories on Free, Pro and Team ([GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). Standard GitHub-hosted runners are free for public repositories ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). The only spend is Grok API tokens from the recruiter's credit.

## Interview finish line

Show the live trigger, a specialist-to-specialist clarification, the approved plan on the Issue, the Cursor handoff and its PR, the trusted assessor run with the Grok call site open, the structured risk report, Assurance's recommendation and the human merge decision. Open each bot's configuration, the repository rules and skills, and the workflow files. Two slides. One rehearsed live change, with a second ready.

Claim only what runs: a PR-stage release-readiness system. The existing CI/CD attaches after merge as it does today.
