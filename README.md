# build-something

Synthetic release-readiness demo. The design is in [PROJECT-BRIEF.md](PROJECT-BRIEF.md) and [PROJECT-PLAN.md](PROJECT-PLAN.md). Agent instructions and commands are in [AGENTS.md](AGENTS.md). Service owners and AUTH-DOC-001 are in [docs/service-catalog.md](docs/service-catalog.md).

These files are not deployed. The release-risk assessor and live API evaluation are pending.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies from `package-lock.json`. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm run validate` | Schema-validate every synthetic JSON file and compile the contract schemas. |
| `npm run check:resources` | Check each service config for a valid CPU/memory pair. |
| `npm run check:scope` | Check synthetic files against the catalog path shapes. This is not a plan approval unless `--allowed` and `--changed` are supplied. |
| `npm run test` | Run the unit tests. |
| `npm run check` | Run typecheck, schema validation, the CPU/memory check, the scope check, and the tests. |
| `npm run eval` | Pending. Exits non-zero. Live API evaluation has not been run. |

Node.js 22 or newer is required. Dependency versions in `package.json` are exact.
