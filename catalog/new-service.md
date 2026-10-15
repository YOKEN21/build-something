# New service

Starting risk: Medium.

## Files touched

- `services/<product>/<service>/config.json`
- `iam/<product>-task-roles.json`

## Complete request

A complete request contains:

- issue number
- change type `new-service`
- summary
- product
- service
- environment
- allowed paths for that product and service, limited to the two files above
- plan revision
- acceptance expectation

The request shape is `contracts/change-request.schema.json`.

## Shape

Copy `services/matter/matter-search/config.json` and the matter-search role in `iam/matter-task-roles.json`. Keep the synthetic account `111111111111`. CPU and memory must be a valid pair from `catalog/config-change.md`.

The matter-search task role has no statements and no access to `example-documents-dev`. A new service does not receive that access unless an existing authorization record names it. Do not add an authorization record as part of creating the service.

## Starting risk

Medium.

IAM findings still apply to the new role. Broad wildcard grants, `iam:`, `kms:`, `sts:`, cross-account access, and prod follow `catalog/iam-permission-change.md` and `policy/release-rules.json`.
