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

## Policy note

Ownership alone is not authorization. A request is authorized only when an authorization record names the consumer, environment, account and scope. Ownership without a matching authorization record, or any access beyond the recorded scope, environment or account, is unresolved authorization and produces HUMAN under the decision policy (cross-account remains blocking under IAM-04). Specialists must cite the record ID.
