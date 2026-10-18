# AGENTS.md

This repository is a public synthetic demo of a release-readiness system for `YOKEN21/build-something`. Nothing here is deployed. Names, account IDs, and authorization records are fictional. The design is in `PROJECT-BRIEF.md` and `PROJECT-PLAN.md`. The service catalog is `docs/service-catalog.md`.

## How to work

- Implement only the work package named in the task. Later phases in the plan are context, not authorization.
- Read the relevant page in `catalog/` before editing a service config or a task role.
- Follow `.cursor/rules/` and the procedure in `.cursor/skills/implement-change/SKILL.md` or `.cursor/skills/repair-from-evidence/SKILL.md`.
- Touch only the allowed paths. Stop at the pull request. Do not merge.
- Do not invent approvals, authorization records, or assessment results.
- AUTH-DOC-001 is the only authorization record. Leave that row unchanged unless a task explicitly edits it.
- The synthetic account in the baseline is `111111111111`.
- `iam/matter-task-roles.json` has no documents-bucket grant. Add one only when the task is that IAM change.
- The release-risk assessor is `src/risk-assessor/`. `risk-assessment.yml` runs that trusted code from `main`. Do not put `XAI_API_KEY` or any other secret in the repository.
- Live API evaluation is NOT RUN. `npm run eval` must exit non-zero. Do not report it as a pass.
- The `grok-assessment` environment and its reviewer are not set up. That is a pending account setting.
- Read AUTH-DOC-001 from the Markdown table in `docs/service-catalog.md`. Do not add a JSON copy of authorization records.
- `npm run check:scope` with no plan path list exits non-zero. The structural catalog check runs only with `--structural-only`. `npm run check` passes that flag.
- This foundation has no GitHub Issue and no plan-approval comment in the repository. Chat authorization is not an approval record. An ordinary catalog task must not edit the assessor, the assessment workflow, or the policy.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies from `package-lock.json`. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm run validate` | Schema-validate every synthetic JSON file and compile the contract schemas. |
| `npm run check:resources` | Check each service config for a valid CPU/memory pair. A valid pair above the preferred maximum stays valid. |
| `npm run check:scope` | With no plan path list, exit non-zero. `--allowed` and `--changed` compare a change with a plan. `--structural-only` checks catalog path shapes and is not a plan approval. |
| `npm run test` | Run the unit tests. |
| `npm run check` | Run typecheck, schema validation, the CPU/memory check, the scope check, and the tests. |
| `npm run eval` | Pending. It exits non-zero. Live API evaluation is NOT RUN. |

`npm run check:scope -- --allowed <paths> --changed <paths>` compares a comma-separated changed list with a comma-separated allow-list. An empty allow-list does not allow every file.

## Checks

`npm run check` is secret-free. It does not call an API. `.github/workflows/checks.yml` runs `npm ci` and `npm run check` on pushes and pull requests.

`npm run eval` is the placeholder for the ten core cases. Live API evaluation is NOT RUN, so the command stops and must not be reported as a pass. The assessor tests use a simulated provider. `.github/workflows/risk-assessment.yml` is the key-bearing workflow. It runs only from `refs/heads/main`, checks out the trusted commit, and does not execute candidate code. The `grok-assessment` environment is still a pending account setting. Assessment normally starts automatically after checks, and manual dispatch is recovery.
