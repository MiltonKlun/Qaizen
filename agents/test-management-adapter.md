---
name: test-management-adapter
description: |
  The PORT (stable interface) that every test-management integration
  implements. The pipeline's source of truth is always
  test-cases/[story-id].json + release/release-report.json; a
  test-management tool (TestLink now; Xray / Qase later) is a downstream
  sync TARGET behind this port. Adding a new tool is additive — a new
  adapter behind this interface — never an edit to the pipeline core or
  to another tool's adapter (Open/Closed Principle).
phase_introduced: 2
phase_active: 2+
version: 1.0.0
changed_in_run: null
changelog: |
  - 1.0.0: Initial versioned baseline (Phase 3 TG8). The port (Open/Closed)
    for test-management sync targets; TestLink + plain-Jira adapters active,
    Xray/Qase planned. Versioning the port lets adapters evolve independently.
owned_outputs: []
implemented_by:
  - skills/syncing-testlink (TestLink — Phase 2, active)
  - skills/syncing-jira (plain Jira issues — Phase 2.6, active)
  - skills/syncing-xray (Xray — planned, not built)
  - skills/syncing-qase (Qase — planned, not built)
---

# Test Management Adapter (the port)

This file defines the **port**: the small, stable contract that any
test-management integration must satisfy. It exists so the project can
add or swap test-management tools **by extension, not modification** —
the SOLID Open/Closed Principle applied to integrations.

> **Why this exists / deviation note.** The original integration plan
> hardcoded TestLink. The project owner asked for a modular design so
> future tools (Xray, Qase) slot in without touching TestLink's code —
> test management is "an adapter, not a hardcoded coupling." This
> formalizes an intent the architecture already had (logged in
> `docs/ambiguities.md` A6). TestLink is the first implemented adapter.

---

## 1. The core principle

```
   Pipeline core (NEVER changes when you add or swap a tool)
   ────────────────────────────────────────────────────────
   test-cases/[story-id].json        ← source of truth for test cases
   release/release-report.json       ← source of truth for results
   analysis/failure-analysis.json    ← source of truth for failures
                     │
                     ▼
        TestManagementAdapter  ← THE PORT (this file)
          • verifyConnection()
          • pushTestCases(approvedCases) -> [{ test_case_id, external_id }]
          • pushExecutionResults(results)
                     │
        ┌────────────┼─────────────────────────┐
        ▼            ▼                          ▼
  syncing-testlink   syncing-xray (planned)   syncing-qase (planned)
  (Phase 2, active)  uses Jira+Xray REST      uses Qase REST
```

**The tool is never the source of truth.** `test-cases/*.json` is.
Adapters push _to_ the tool and write back only an `external_id` /
`testlink_id` linkage. Swapping tools can never corrupt the canonical
data, because the canonical data does not live in the tool.

---

## 2. The port — operations every adapter implements

An adapter is a `skills/syncing-<tool>/SKILL.md` (+ optional helper
script) that provides these three operations. The names are conceptual;
each adapter realizes them via its tool's MCP or REST API.

### `verifyConnection()`

- Confirms the tool is reachable and the credentials work.
- Returns the configured project (and plan, if the tool has one) so the
  human can confirm they're pointing at the right place.
- Read-only. Safe to run any time. This is the TG3 "test connection"
  check.

### `pushTestCases(approvedCases) -> [{ test_case_id, external_id }]`

- Input: the **`status == "approved"`** subset of
  `test-cases/[story-id].json`. Adapters MUST ignore `draft`,
  `rejected`, and `skip` cases.
- Creates or updates the corresponding cases in the tool, mapping our
  fields to the tool's fields via the adapter's own
  `config/<tool>-field-map.json`.
- Writes the tool's identifier back into our JSON. The generic slot is
  `test_cases[].external_ids` (a `{ tool: id }` object, Phase 2.6) — e.g.
  the Jira adapter writes `external_ids.jira = "SK-50"`. The TestLink
  adapter additionally keeps its legacy dedicated `testlink_id` field for
  backward compatibility. New adapters use `external_ids`.
- Links to the Jira story when `context.json.story.jira_issue_key`
  exists, if the tool supports it.
- **Idempotent:** re-running updates the same cases (matched by the
  written-back id or by `test_case_id`), never duplicates.

### `pushExecutionResults(results)`

- Input: per-TC execution outcomes derived from
  `analysis/failure-analysis.json` + the release report.
- Maps each outcome to the tool's status vocabulary via the adapter's
  status map (e.g. `config/testlink-status-map.json` in Phase 2 TG10).
- Only acts on cases that have an `external_id` (i.e. were pushed
  first).

---

## 3. Selection — which adapter is active

A single env var picks the active adapter:

```
TEST_MANAGEMENT_TOOL=testlink   # | jira | both | xray | qase | none
```

- `testlink` — the Phase 2 adapter (active). `scripts/sync-to-testlink.js`.
- `jira` — the Phase 2.6 adapter (active): creates test cases as **ordinary
  Jira issues** (no Xray app needed). `scripts/create-jira-testcases.js`,
  which refuses to run unless this var is `jira` or `both`.
- `both` — run TestLink **and** Jira (a reuser mirroring to both).
- `xray`, `qase` — planned; selecting them before the adapter exists is
  an error the dispatcher reports cleanly.
- `none` — skip test-management sync entirely (valid; the pipeline still
  produces `test-cases/*.json` + the release report, which stand on
  their own).

> **`jira` vs `xray`:** the `jira` adapter creates plain Jira issues — works
> on any Jira project, no paid app. A future `xray` adapter would use Xray's
> test-entity APIs for richer test management. They are distinct adapters; a
> reuser picks what their Jira has.

The dispatcher (`scripts/sync-test-management.js`, introduced when a
second adapter lands; in Phase 2 the TestLink script is called directly)
reads this var and routes to the matching adapter. **The dispatcher's
lookup table is the only thing that grows when you add a tool** — you
add a row, you never edit an existing adapter. That is the Open/Closed
guarantee.

---

## 4. Hard rules for every adapter

- **Source of truth is `test-cases/*.json`.** Never treat the tool as
  authoritative. If the tool and our JSON disagree, our JSON wins; the
  adapter re-pushes.
- **Sync only `approved` cases.** Never push `draft` / `rejected` /
  `skip`.
- **Dry-run by default.** Every adapter and its script default to a
  dry-run that prints what it _would_ do. A real write requires an
  explicit flag (`--apply-testlink`, `--apply-testlink-execution`, and
  the tool-specific equivalents). Same discipline as
  `scripts/create-jira-bugs.js --apply`.
- **Never invent the tool's schema.** Field mappings live in
  `config/<tool>-field-map.json`, not in adapter logic. Status mappings
  live in `config/<tool>-status-map.json`. Both are human-editable; no
  mapping is hardcoded (Phase 2 non-negotiable rule).
- **Credentials from env, never committed.** See
  `docs/secrets-management.md`.
- **Write back the linkage.** After a push, record the tool's id in our
  JSON so the chain `TC-XXX → external_id` is preserved
  (`docs/traceability.md`).
- **No gate bypass.** Test cases are only synced after Gate 2 approval
  (they must be `approved`). Execution results only after the run
  completed through Gate 4.

---

## 5. Implemented + planned adapters

| Adapter                   | Tool              | Status                 | API surface                           | Notes                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------- | ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/syncing-testlink` | TestLink          | **Active (Phase 2)**   | `dogkeeper886/testlink-mcp` (XML-RPC) | The reused `ai-qa-workflow` skill, adapted. See `docs/testlink-integration.md`. Writes `testlink_id` (+ mirrored to `external_ids.testlink`).                                                                                                                                                  |
| `skills/syncing-jira`     | Plain Jira issues | **Active (Phase 2.6)** | Jira REST v3 (`/rest/api/3/issue`)    | Creates ordinary Jira issues (type configurable, default `Test`) — no Xray app required, works on any Jira. Rides the existing `JIRA_*` token. `scripts/create-jira-testcases.js`, `--apply`-gated, dedup via `external_ids.jira`. See `docs/jira-export.md` for the related read-only export. |
| `skills/syncing-xray`     | Xray (Jira app)   | **Planned**            | Jira REST + Xray REST/GraphQL         | Distinct from `syncing-jira`: uses Xray's test-entity APIs for richer test management. Build when the team has Xray and wants Jira-unified test management.                                                                                                                                    |
| `skills/syncing-qase`     | Qase              | **Planned**            | Qase REST (`api.qase.io`)             | Modern, clean API, good free tier. Best non-Jira modern option and the lowest-effort adapter to add — also a good "is the port truly tool-agnostic?" stress test. Build when a non-Jira option is wanted.                                                                                      |

**When to build Xray / Qase:** after Phase 2 proves the sync mechanism
works end-to-end with TestLink. At that point each new adapter is a
contained, additive change: a new `skills/syncing-<tool>/SKILL.md`, a new
`config/<tool>-field-map.json` (+ status map), and one new row in the
dispatcher's `TEST_MANAGEMENT_TOOL` lookup. **Zero edits** to the
TestLink adapter or the pipeline core. We do not build them speculatively
now — the port is designed so they are cheap to add exactly when they
suit the project.

---

## 6. References

- `skills/syncing-testlink/SKILL.md` — the first adapter (Phase 2 TG4).
- `docs/testlink-integration.md` — TestLink specifics: MCP config, field
  map, setup.
- `docs/secrets-management.md` — credential handling for all adapters.
- `docs/traceability.md` — the `TC-XXX → external_id` linkage adapters
  preserve.
- `docs/review-gates.md` — Gate 2 (cases) / Gate 4 (results) gating that
  bounds when sync may run.
- `agents/test-designer.md` — owns `test-cases/*.json`, the source of
  truth adapters read.
- `agents/reporter.md` — owns the release report; result sync is wired
  through the reporter.
- `docs/ambiguities.md` A6 — the modular-port deviation record.
