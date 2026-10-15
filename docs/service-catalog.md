# Service catalog

**All names, accounts, teams and authorization records in this document are fictional demo data created for the release-readiness demonstration. This is not real infrastructure and does not represent an actual policy.**

## Teams

| Team | Responsibility |
| --- | --- |
| `platform-data` | Owns shared data stores |
| `matter` | Owns the matter-search service |

## Resources

| Name | ARN | Environment | Account (synthetic) | Owner |
| --- | --- | --- | --- | --- |
| `example-documents-dev` | `arn:aws:s3:::example-documents-dev` | dev | `111111111111` | `platform-data` |

## Authorization records

| ID | Consumer | Access | Environment | Account | Approved scope | Owner approval |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-DOC-001 | `matter-search` (task role in `iam/matter-task-roles.json`) | read-only | dev only | same account only | Bucket-level `s3:ListBucket` on `arn:aws:s3:::example-documents-dev` limited to prefix `incoming/`; object-level `s3:GetObject` on `arn:aws:s3:::example-documents-dev/incoming/*` | `platform-data` (synthetic, pre-authorized for demo) |

## Services

Synthetic baseline only. This table is not an authorization record. The matter-search task role in `iam/matter-task-roles.json` has an empty statement list and does not yet include the AUTH-DOC-001 grant.

| Service | Product | Owner | Environment | Account | CPU units | Memory (MiB) | Public endpoint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `matter-search` | `matter` | `matter` | dev | `111111111111` | 512 | 1024 | false |

Preferred catalog maximum for a config change: CPU 1024 and memory 2048. A valid pair above that maximum is SIZE-01. Valid pairs are listed in `catalog/config-change.md`.

## Policy decisions

Kenny decided the following. `PROJECT-PLAN.md` states the same five decisions. They do not add an authorization record. AUTH-DOC-001 stays unchanged.

1. The exact approved bucket and object prefix are permitted.
2. A wildcard grant demonstrably broader than the recorded authorization is IAM-02 = NO-GO.
3. Missing or ambiguous ownership or authorization evidence = HUMAN.
4. Cross-account access stays IAM-04 = NO-GO.
5. The assessor evaluates the candidate commit but runs trusted code from `main`.

## Policy note

Ownership alone is not authorization. A request is authorized only when an authorization record names the consumer, environment, account and scope. The exact approved bucket and object prefix are permitted. For AUTH-DOC-001 that scope is bucket-level `s3:ListBucket` on `arn:aws:s3:::example-documents-dev` limited to prefix `incoming/`, and object-level `s3:GetObject` on `arn:aws:s3:::example-documents-dev/incoming/*`. A wildcard grant demonstrably broader than the recorded authorization is IAM-02 = NO-GO. Missing or ambiguous ownership or authorization evidence = HUMAN. Cross-account access stays IAM-04 = NO-GO. The assessor evaluates the candidate commit but runs trusted code from `main`. Specialists must cite the record ID. Do not add a new authorization record here.
