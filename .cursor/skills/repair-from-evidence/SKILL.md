---
name: repair-from-evidence
description: Repair one in-scope defect shown by failed evidence for the current head. The checks in the procedure are npm run check. Use when a check or a risk report for this head shows a defect still inside the allowed paths.
---

# Repair from evidence

Use this skill when evidence for the current pull request head shows a defect. A report for a different head is not evidence for this head. Do not invent a replacement result. Do not merge.

## Procedure

1. Read the task and the relevant catalog.
2. Inspect the existing files.
3. Make the smallest in-scope change.
4. Run the checks.
5. Inspect the final diff.
6. Return the evidence and limitations.
