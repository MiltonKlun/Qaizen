---
name: syncing-jira
description: |
  Manage phase. The plain-Jira adapter behind the TestManagementAdapter
  port (agents/test-management-adapter.md). Creates the approved test
  cases from test-cases/[story-id].json as ordinary Jira issues (type
  configurable, default "Test" — no Xray app needed), links each to the
  story issue, and writes the created key back as external_ids.jira.
  Source of truth is test-cases/*.json; Jira is a downstream target
  selected by TEST_MANAGEMENT_TOOL=jira|both.
disable-model-invocation: true
---

# syncing-jira — the plain-Jira test-case adapter (Phase 2.6 TG2.6-3)

The Jira implementation of the `TestManagementAdapter` port. It creates
**ordinary Jira issues** for approved test cases, so it works on any Jira
project without the paid Xray app. A reuser who lives in Jira (no TestLink)
selects it with `TEST_MANAGEMENT_TOOL=jira`. The distinct future `syncing-xray`
adapter would instead use Xray's test-entity APIs.

## Mechanism (do not re-implement in prose — the script is the adapter)

`node scripts/create-jira-testcases.js <story-id>` — dry-run, prints the plan.
`node scripts/create-jira-testcases.js <story-id> --apply` — real Jira writes.
`--limit N` caps how many are created in one run.

The script:

- Refuses to run unless `TEST_MANAGEMENT_TOOL` is `jira` or `both` (so a
  testlink/none repo never writes to Jira by accident).
- Re-checks **Gate 2** (`test_scope_reviewed`); refuses otherwise.
- Syncs only `status == "approved"` cases (never draft/rejected/skip).
- Maps fields via `config/jira-testcase-map.json` — **never hardcoded**
  (issue type, priority map, labels, link type, write-back key).
- **Idempotent / duplicate-safe:** a case already carrying
  `external_ids.jira` is skipped; re-running creates nothing new.
- Links each created issue to the story when `context.story.jira_issue_key`
  exists (link type from the field map).
- Writes the created key back into `test-cases/<story-id>.json` under
  `external_ids.jira` (the generic linkage slot, schema Phase 2.6).
- Dry-run by default; a real write needs the human-typed `--apply` — the
  same discipline as `scripts/create-jira-bugs.js`.

## Hard rules (inherited from the port)

- Source of truth is `test-cases/*.json`; Jira is a mirror.
- Approved-only; Gate 2 gates it.
- No mapping hardcoded — it all lives in `config/jira-testcase-map.json`.
- Credentials from env (`JIRA_*`), never committed.
- Dry-run default; `--apply` is a deliberate human action.

## Field mapping

`config/jira-testcase-map.json`. Our `test_case_id`+`title` → Summary;
description assembled from description/preconditions/steps/expected_results;
`priority` → Jira priority (configurable map); labels include the story id +
test_case_id for traceability. The created key is recorded at
`external_ids.jira`.

## References

- `agents/test-management-adapter.md` — the port this implements.
- `scripts/create-jira-testcases.js` — the adapter script.
- `config/jira-testcase-map.json` — the (human-editable) field map.
- `scripts/create-jira-bugs.js` — sibling write-capable, `--apply`-gated path.
- `docs/jira-export.md` — the related read-only export.
