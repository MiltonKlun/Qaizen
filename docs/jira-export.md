# Jira export helper (TG2.6-2, TG14 Option A)

> **Status:** Phase 2.6. A one-way export of local test cases into Jira-ready
> output. The human pastes/imports it — **the script never writes to Jira**,
> so there is zero risk to a shared board. For automated, config-selected
> creation behind the `TestManagementAdapter` port, see TG2.6-3
> (`scripts/create-jira-testcases.js`) and
> `agents/test-management-adapter.md`.

Source of truth stays `test-cases/<story-id>.json`. This is an export
convenience, not a sync; nothing is written back.

---

## Usage

```
node scripts/export-to-jira.js <story-id>                  # markdown (default), to stdout
node scripts/export-to-jira.js <story-id> --format csv     # CSV for Jira's bulk importer
node scripts/export-to-jira.js <story-id> --out file.csv   # write to a file instead of stdout
node scripts/export-to-jira.js <story-id> --include-risks  # also list the context.json risks
node scripts/export-to-jira.js <story-id> --approved-only  # only status=approved test cases
```

(`npm run export:jira -- <story-id> [flags]` also works.)

### Two formats

- **markdown** (default) — one block per test case (title, priority, status,
  description, preconditions, numbered steps, expected results, traceability
  line). Paste a block into a Jira issue's description. Good for a handful of
  cases.
- **csv** — columns `Project Key, Issue Type, Summary, Description, Priority,
Labels`, one row per test case, ready for **Jira → filters/issues → Import
  issues from CSV**. Good for creating many at once. Descriptions are quoted
  (they contain newlines) — that is valid CSV and Jira's importer handles it.

### Optional env (from `.env`)

- `JIRA_PROJECT_KEY` — prefills the CSV "Project Key" column (the importer
  lets you remap it anyway).
- `JIRA_TESTCASE_ISSUETYPE` — issue type label (default `Test`).

---

## What it maps

| Our `test-cases/*.json` field                                  | Jira export                                       |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `test_case_id` + `title`                                       | Summary (`TC-001 <title>`)                        |
| `description` / `preconditions` / `steps` / `expected_results` | Description (assembled)                           |
| `priority` (`P0`–`P3`)                                         | Priority (as-is; remap in the importer if needed) |
| `risk_ids` + `story_id`                                        | Labels + a traceability line in the description   |

The export deliberately stays tool-neutral (plain Summary/Description/
Priority/Labels) so it works on any Jira project regardless of custom
schemes — consistent with the project's generic/reusable goal.

---

## References

- `scripts/export-to-jira.js` — the helper.
- `phase2.6-enhancements.md` TG2.6-2 — the plan.
- `agents/test-management-adapter.md` — the port; the automated Jira adapter
  (TG2.6-3) lives behind it.
- `scripts/create-jira-bugs.js` — the related (write-capable, `--apply`-gated)
  bug-promotion path whose parser shape this reuses.
