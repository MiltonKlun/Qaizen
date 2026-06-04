---
name: syncing-testlink
description: |
  Manage phase. The TestLink adapter behind the TestManagementAdapter
  port (agents/test-management-adapter.md). Syncs the approved test
  cases from test-cases/[story-id].json into TestLink (suites + cases +
  plan assignment), writes the TestLink id back as testlink_id, and —
  in Phase 2 TG10 — reports execution results against the test plan.
  Source of truth is test-cases/*.json; TestLink is a downstream target.
disable-model-invocation: true
adapted_from: dogkeeper886/ai-qa-workflow @ v3.0
adaptation_notes: |
  Original skill reads ai-qa-workflow's test_cases/TS-XX_*.md markdown
  files and drives /tl-* slash commands. This adaptation reads our
  schema-validated test-cases/[story-id].json, syncs only status ==
  "approved" cases, maps fields via config/testlink-field-map.json
  (never hardcoded), writes testlink_id back into our JSON, and links to
  the Jira story when story.jira_issue_key exists. It is framed as the
  first concrete adapter behind the test-management port, so Xray/Qase
  adapters can be added later without touching this one.
implements_port: agents/test-management-adapter.md
tools:
  - testlink-mcp:list_projects
  - testlink-mcp:create_test_suite
  - testlink-mcp:create_test_case
  - testlink-mcp:update_test_case
  - testlink-mcp:list_test_cases_in_suite
  - testlink-mcp:create_test_plan
  - testlink-mcp:add_test_case_to_test_plan
  - testlink-mcp:get_test_cases_for_test_plan
  - testlink-mcp:report_test_case_result
---

# syncing-testlink (TestLink adapter)

**Phase:** 2+
**Implements:** the `TestManagementAdapter` port
(`agents/test-management-adapter.md`) — `verifyConnection`,
`pushTestCases`, `pushExecutionResults`.
**Owned by:** the Test Designer Agent invokes the `pushTestCases` path
after Gate 2; the Reporter Agent invokes the `pushExecutionResults`
path after the run (Phase 2 TG10).
**Source of truth:** `test-cases/[story-id].json`. TestLink is a
downstream sync target — never authoritative.

This adapter does not own any pipeline artifact. It reads
`test-cases/[story-id].json` and writes a `testlink_id` back into each
synced case (the only mutation it makes to our files). It is invoked
with an explicit `--apply-testlink` intent; without it, it is a
dry-run.

---

## Hard preconditions

- **Gate 2 passed** (`context.json.review_gates.test_scope_reviewed ==
true`) for `pushTestCases`. You do not sync unreviewed scope.
- **Run completed through Gate 4** for `pushExecutionResults` — results
  only exist after execution.
- TestLink reachable and credentials valid (run `verifyConnection`
  first). See `docs/testlink-integration.md` for the URL/networking
  gotchas.

If a precondition fails, stop and report. Do not partial-sync.

---

## verifyConnection — Step 0 (always first, read-only)

Use `testlink-mcp:list_projects`. Confirm the target project
(`TESTLINK_PROJECT_KEY`, e.g. `AIQA`) is present. This is the TG3
connection test and is safe to run any time. Report which project +
plan you're pointed at so the human can confirm it's the right target.

---

## pushTestCases — sync approved cases

### Step 1: Validate prerequisites

- `context.json.review_gates.test_scope_reviewed == true`.
- `test-cases/[story-id].json` exists and validates against
  `schemas/test-cases.schema.json`.
- `config/testlink-field-map.json` exists (the field mapping; never
  hardcode the mapping in this skill).

### Step 2: List projects, confirm target

`testlink-mcp:list_projects` → confirm `TESTLINK_PROJECT_KEY`.

### Step 3: Filter to approved cases

From `test-cases/[story-id].json`, take **only** the cases where
`status == "approved"`. Explicitly skip `draft`, `rejected`, and
`skip`. If zero cases are approved, report and stop — nothing to sync.

### Step 4: Create the story's test suite

Create (or reuse) a test suite named after the story — e.g.
`STORY-002 — Account access` — under the project. One suite per story
keeps TestLink browsable and mirrors our per-story JSON. Use
`testlink-mcp:create_test_suite`. Record the suite id.

### Step 5: Sync each approved case (diff: skip/update/create)

For each approved case, map our fields → TestLink fields via
`config/testlink-field-map.json`:

| Our field                                  | TestLink field                                                        |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `test_case_id`                             | `external_id` (linkage key)                                           |
| `title`                                    | `name`                                                                |
| `description`                              | `summary`                                                             |
| `preconditions`                            | `preconditions`                                                       |
| `steps` (action/data) + `expected_results` | TestLink steps (actions/expected)                                     |
| `priority`                                 | `importance` (via the map)                                            |
| `automation_decision`                      | `execution_type` (automate\_\* → 2 automated; manual/skip → 1 manual) |

Diff logic before writing (idempotent — never duplicate):

- **MATCHING** (the case exists by `testlink_id`/name and all mapped
  fields equal) → skip.
- **DIFFERS** (exists but fields changed) → `update_test_case` for the
  differing fields only.
- **NEW** (no `testlink_id`, name not found) → `create_test_case`.

Use `testlink-mcp:list_test_cases_in_suite` to detect existing cases.

### Step 6: Write back the linkage

For every created/updated case, write TestLink's id into our
`test-cases/[story-id].json` as `testlink_id` on that case. Re-validate
the JSON against the schema after writing (the schema already allows
`testlink_id`). This preserves the `TC-XXX → testlink_id` chain in our
source of truth.

### Step 7: Add to the test plan + link the story

- `testlink-mcp:add_test_case_to_test_plan` to add the synced cases to
  `TESTLINK_TEST_PLAN_ID`.
- If `context.json.story.jira_issue_key` exists, record the Jira key on
  the cases / suite where TestLink supports it (custom field or
  summary reference) so the story↔testcase link survives.

### Step 8: Verify count

`testlink-mcp:get_test_cases_for_test_plan` → count vs the number of
approved local cases. Report **PASS** (match) or **FAIL** (mismatch)
and the plan id.

### Dry-run vs apply

Default is **dry-run**: print the suite/case/plan actions you _would_
take, the diff classification per case, and the field mapping — but
make no TestLink writes and no `testlink_id` write-back. A real sync
requires the explicit `--apply-testlink` intent (the Test Designer
agent passes it only when the human asked). This mirrors
`scripts/create-jira-bugs.js --apply`.

`scripts/sync-to-testlink.js` is the non-interactive equivalent for CI
(same dry-run default, same `--apply-testlink` flag).

---

## pushExecutionResults — report results (Phase 2 TG10)

After a run completes (through Gate 4) and the Reporter has produced
`release/release-report.json` + `analysis/failure-analysis.json`:

- For each case that has a `testlink_id`, map its outcome to a TestLink
  status via `config/testlink-status-map.json` (created in TG10):
  - `passed` → Pass
  - `product_bug` → Fail
  - `flaky` / `environment_issue` / `test_bug` / `test_data_issue` /
    `unknown_needs_human_review` → Blocked
  - `skipped` → Not Run
- `testlink-mcp:report_test_case_result` against
  `TESTLINK_TEST_PLAN_ID`.
- Default dry-run; real write requires `--apply-testlink-execution`.

This path is wired by `agents/reporter.md` in TG10; the mapping and the
flag are defined here for completeness.

---

## Rules

- **Sync only `approved` cases.** Never push `draft`/`rejected`/`skip`.
- **Source of truth is our JSON.** If TestLink and our JSON disagree,
  our JSON wins; re-push.
- **No hardcoded mapping.** Field + status maps live in
  `config/testlink-*-map.json`, human-editable.
- **Dry-run by default; explicit flag to write.** Both `pushTestCases`
  (`--apply-testlink`) and `pushExecutionResults`
  (`--apply-testlink-execution`).
- **Idempotent.** Re-running never duplicates; it skips/updates by
  `testlink_id`.
- **Credentials from env.** `TESTLINK_*` from `.env`, never committed.
- **Stay in folder ownership.** The only file this adapter writes in our
  tree is the `testlink_id` write-back into `test-cases/[story-id].json`
  (a field the Test Designer's schema owns and permits). It writes
  nothing else in our repo; everything else it does lives in TestLink.

---

## When to stop and ask

- A precondition (Gate 2 / Gate 4 / connection) fails.
- The target project (`TESTLINK_PROJECT_KEY`) isn't found by
  `list_projects` — wrong key or wrong instance.
- A field can't be mapped because `config/testlink-field-map.json` has
  no entry for it — fix the map, don't improvise in the skill.
- The count verify FAILs — report it; don't silently accept a partial
  sync.

---

## References

- `agents/test-management-adapter.md` — the port this skill implements.
- `docs/testlink-integration.md` — MCP config, URL gotchas, field map,
  setup.
- `config/testlink-field-map.json` — the field mapping (this skill never
  hardcodes it).
- `config/testlink-status-map.json` — the execution-status mapping
  (TG10).
- `scripts/sync-to-testlink.js` — the CI-friendly equivalent.
- `schemas/test-cases.schema.json` — defines `testlink_id`, the
  write-back field.
- `docs/review-gates.md` — Gate 2 / Gate 4 preconditions.
- `agents/test-designer.md` (TG10) — invokes `pushTestCases`.
- `agents/reporter.md` (TG10) — invokes `pushExecutionResults`.
