---
name: implement-change
description: Implement one catalog change inside the task's allowed paths. The checks in the procedure are npm run check. Use when a task asks for a new service, a config change, or an IAM permission change.
---

# Implement change

Use this skill for one in-scope catalog change. Stop at the pull request. Do not merge. Do not invent an approval, an authorization record, or an assessment result.

## Procedure

1. Read the task and the relevant catalog.
2. Inspect the existing files.
3. Make the smallest in-scope change.
4. Run the checks.
5. Inspect the final diff.
6. Return the evidence and limitations.
