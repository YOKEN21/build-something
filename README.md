# build-something

Synthetic release-readiness demo. The design is in [PROJECT-BRIEF.md](PROJECT-BRIEF.md) and [PROJECT-PLAN.md](PROJECT-PLAN.md). Agent instructions and commands are in [AGENTS.md](AGENTS.md). Service owners and AUTH-DOC-001 are in [docs/service-catalog.md](docs/service-catalog.md).

These files are not deployed. The release-risk assessor is `src/risk-assessor/`. Live API evaluation is NOT RUN. The `grok-assessment` environment and its reviewer are not set up.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies from `package-lock.json`. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm run validate` | Schema-validate every synthetic JSON file and compile the contract schemas. |
| `npm run check:resources` | Check each service config for a valid CPU/memory pair. |
| `npm run check:scope` | With no plan path list, exit non-zero. `--structural-only` checks catalog path shapes and is not a plan approval. |
| `npm run test` | Run the unit tests. |
| `npm run check` | Run typecheck, schema validation, the CPU/memory check, the scope check, and the tests. |
| `npm run eval` | Pending. It exits non-zero. Live API evaluation is NOT RUN. |

Node.js 22 or newer is required. Dependency versions in `package.json` are exact.

## Release-risk assessor

The assessor collects the plan, its approval, the diff, the catalog, the check results, and the trusted policy. Code applies SCOPE-01, SELF-01, IAM-01 through IAM-04, ENV-01, NET-01, SIZE-01, and CHECK-01. A confirmed blocker is NO-GO. Incomplete, stale, unresolved, high, or `needs_human` is HUMAN. GO requires every remaining condition. AUTH-DOC-001 is read from the Markdown table in `docs/service-catalog.md` at the trusted commit. An owner match alone is not authorization.

The model call is one Responses API request to `https://api.x.ai/v1/responses` with `text.format.strict` true. The model id comes from `XAI_MODEL` and defaults to `grok-4.7`. Reasoning effort is `high`. Temperature is 0.7 and top_p is 0.95. `store` is false. The key is read only from `XAI_API_KEY`. Timeout is 900 seconds per attempt. Retry budget is 3 attempts for timeout, network failure, 429, and 5xx. Docs used:

- https://docs.x.ai/developers/model-capabilities/text/structured-outputs
- https://docs.x.ai/developers/model-capabilities/text/best-practices
- https://docs.x.ai/developers/model-capabilities/text/comparison
- https://docs.x.ai/developers/model-capabilities/text/generate-text
- https://docs.x.ai/developers/rest-api-reference/inference/responses

Assessment normally starts automatically after checks, and manual dispatch is recovery. A secret-free job records the trusted commit, collects the candidate as data, and posts those preserved inputs. The assessment job checks out that commit, rechecks the head, plan, and approval, and installs only that commit's dependencies. Candidate code is data. Live evaluation has not been run.
