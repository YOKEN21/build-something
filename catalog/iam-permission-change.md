# IAM permission change

Starting risk: Medium; High for broad wildcard grants, `iam:`, `kms:`, `sts:`, cross-account or prod.

## Files touched

- `iam/<product>-task-roles.json`

## Complete request

A complete request contains:

- issue number
- change type `iam-permission-change`
- summary
- product
- service
- environment
- allowed paths, limited to `iam/<product>-task-roles.json`
- plan revision
- acceptance expectation

The request shape is `contracts/change-request.schema.json`.

## Baseline

`iam/matter-task-roles.json` contains the matter-search task role in synthetic account `111111111111`. Its `statements` array is empty. No statement references `example-documents-dev`. A later IAM request has to change this file to add access. Copy the role object and add statements rather than inventing a second file.

## Decisions that apply

1. The exact approved bucket and object prefix are permitted.
2. A wildcard grant demonstrably broader than the recorded authorization is IAM-02 = NO-GO.
3. Missing or ambiguous ownership or authorization evidence = HUMAN.
4. Cross-account access stays IAM-04 = NO-GO.

AUTH-DOC-001 is the only authorization record. It stays unchanged. For that record, the exact approved scope is bucket-level `s3:ListBucket` on `arn:aws:s3:::example-documents-dev` limited to prefix `incoming/`, and object-level `s3:GetObject` on `arn:aws:s3:::example-documents-dev/incoming/*`. That object prefix is permitted. It is not resource `*`. Put bucket-level and object-level actions in separate statements when that grant is made.

Do not add a new authorization record in the service catalog.

## Rule effects

- Wildcard action, resource `*`, or a resource pattern outside the catalog-approved scope: IAM-02, high, blocking, NO-GO.
- `iam:`, `kms:`, or `sts:` action: IAM-03, high, blocking, NO-GO.
- Cross-account access: IAM-04, high, blocking, NO-GO.
- Prod: ENV-01, high.
- Catalog-authorized read access to another team's resource in the same account: IAM-01, medium. Missing or ambiguous ownership or authorization evidence is HUMAN.

See `policy/release-rules.json` for the effect text.
