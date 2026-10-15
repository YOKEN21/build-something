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
- Do not add secrets, `XAI_API_KEY`, a Grok API call, or `risk-assessment.yml`. The assessor and live API evaluation are pending.
- This foundation has no GitHub Issue and no plan-approval comment in the repository. Chat authorization is not an approval record.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies from `package-lock.json`. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm run validate` | Schema-validate every synthetic JSON file and compile the contract schemas. |
| `npm run check:resources` | Check each service config for a valid CPU/memory pair. A valid pair above the preferred maximum stays valid. |
| `npm run check:scope` | Check synthetic files against the catalog path shapes. With no `--allowed` list, this is not a plan approval. |
| `npm run test` | Run the unit tests. |
| `npm run check` | Run typecheck, schema validation, the CPU/memory check, the scope check, and the tests. |
| `npm run eval` | Pending. Exits non-zero. Live API evaluation has not been run. |

`npm run check:scope -- --allowed <paths> --changed <paths>` compares a comma-separated changed list with a comma-separated allow-list. An empty allow-list does not allow every file.

## Checks

`npm run check` is secret-free. It does not call an API. `.github/workflows/checks.yml` runs `npm ci` and `npm run check` on pushes and pull requests.

`npm run eval` is the placeholder for the ten core cases. The release-risk assessor is not implemented, so the command stops and reports that evaluation is pending.
