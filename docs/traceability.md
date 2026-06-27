# Traceability

> **Status:** Phase 1 baseline. The chain documented here is binding from
> Phase 1 day-zero. Phase 1.5 adds the API-branch IDs (`API-XXX`,
> `COL-XXX`, `REQ-XXX`). Later phases do not change the ID model; they
> add new artifacts that hang off the existing IDs.

Every artifact in the pipeline locates itself in a single traceability
chain. This is what makes "the test ran, here's the report" turn into
"this test came from TC-001, which addresses RISK-002 in JIRA-1234,
and it failed at FAIL-001, which we filed as BUG-001".

The chain is **mandatory**. It is enforced at multiple layers:

- Schemas require ID fields on every artifact (e.g. every TC has
  `risk_ids`).
- Skills and agent prompts require each step to wire its new ID to
  the existing IDs.
- `docs/review-gates.md` Gate 2 checks risk coverage; Gate 3 checks
  spec-to-TC mapping; Gate 4 checks test-to-TC mapping.

If a link genuinely cannot be established, the rule is the same one
that applies to ambiguities: **document, don't fake** (see section 5).

---

## 1. The chain

```
JIRA-XXX (or STORY-XXX)
       │
       ▼
   RISK-XXX
       │
       ▼
    TC-XXX  ────────────►  API-XXX        (Phase 1.5+, when automate_api)
       │                       │
       ▼                       ▼
   SPEC-XXX                COL-XXX → REQ-XXX
       │                       │
       ▼                       ▼
    PW-XXX                   (Newman execution)
       │                       │
       └─────────┬─────────────┘
                 ▼
              FAIL-XXX  (per failure across both branches)
                 │
                 ▼
              BUG-XXX  (one per Red failure)
                 │
                 ▼
       (Phase 2: Jira Issue Key promoted via --apply)
```

Top of the chain: a single story. Bottom of the chain: bugs raised
against that story. Every layer in between is a recorded artifact
that knows where it came from.

---

## 2. The IDs, layer by layer

| ID          | What it identifies                                                   | First written by                               | Lives in                                                                                   | Phase introduced |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| `JIRA-XXX`  | A Jira issue key (Mode B: story sourced from Jira via MCP).          | Analyst, copied from Jira.                     | `context.json.story.id` and `story.jira_issue_key`.                                        | 1                |
| `STORY-XXX` | A manual story (Mode A: no Jira).                                    | Analyst.                                       | `context.json.story.id`.                                                                   | 1                |
| `RISK-XXX`  | A product / business / security risk derived from the story.         | Analyst (`skills/receiving-tickets`).          | `context.json.risks[].risk_id`.                                                            | 1                |
| `TC-XXX`    | A business test case.                                                | Test Designer (`skills/designing-cases`).      | `test-cases/[story-id].json` `test_cases[].test_case_id`.                                  | 1                |
| `SPEC-XXX`  | A Playwright Markdown spec scenario.                                 | Playwright Planner Native Agent.               | `specs/[story-id].md` (per-scenario heading or metadata block).                            | 1                |
| `PW-XXX`    | A generated Playwright test (`test(...)` block) inside a spec.       | Playwright Generator Native Agent.             | `tests/[story-id].spec.ts` (in a comment or `test.info().annotations`).                    | 1                |
| `API-XXX`   | An API test case (a TC whose `automation_decision == automate_api`). | Test Designer; parallel to `TC-XXX`.           | `test-cases/[story-id].json`.                                                              | **1.5**          |
| `COL-XXX`   | A Postman collection.                                                | API Agent.                                     | `api-tests/collections/[story-id].postman_collection.json` `info.name` or custom metadata. | **1.5**          |
| `REQ-XXX`   | A single request inside a Postman collection.                        | API Agent.                                     | Same file, per-item name or custom field.                                                  | **1.5**          |
| `FAIL-XXX`  | An individual failed test (Playwright or Newman).                    | Failure Classifier (`skills/analyzing-logs`).  | `analysis/failure-analysis.json` `failures[].failure_id`.                                  | 1                |
| `BUG-XXX`   | A bug draft (one-to-one with each Red `FAIL-XXX`).                   | Failure Classifier; Reporter may add Jira key. | `release/bug-drafts/BUG-XXX.md`.                                                           | 1                |

Phase 2 introduces no new ID — it adds the `Jira Issue Key` to each
existing `BUG-XXX` after `scripts/create-jira-bugs.js --apply`. The
Jira key is _data_ on the bug draft, not a separate traceability ID.

---

## 3. The rules, layer by layer

### 3.1 The story anchors everything

Every artifact in the run carries the story id somewhere. In
`context.json` it's `story.id`. In `test-cases/[story-id].json` and
`api-tests/.../[story-id].postman_collection.json` it's in the
filename. In `failure-analysis.json` it's a top-level field. In each
bug draft it's the **Linked Story** line.

This is what makes "show me everything for JIRA-1234" a single grep.

### 3.2 Every risk has an ID

The Analyst writes risks one at a time, numbering them
`RISK-001`, `RISK-002`, ... within the story. Risks may share themes
across stories but their IDs are scoped to the story. The global
identity of a risk is `<story.id>::RISK-XXX`.

A story with zero risks for non-trivial behavior is a Gate 1
rejection — see `docs/review-gates.md`.

### 3.3 Every test case references ≥ 1 risk

`schemas/test-cases.schema.json` enforces `risk_ids` as a non-empty
array. The Test Designer cannot write a TC with no risk link.

If a TC genuinely doesn't address a risk, that's a sign the TC
shouldn't exist. Either the story is missing a risk (re-open Gate 1)
or the TC is decorative (drop it).

### 3.4 Every planner brief references ≥ 1 TC

The brief at `planner-input/[story-id].planner-brief.md` references
`TC-XXX` IDs in its scenario bullets. The brief does not need to
list every TC — TCs whose `automation_decision` is `manual` or `skip`
do not generate brief scenarios. But every brief scenario must trace
back to at least one TC.

### 3.5 Every spec references ≥ 1 TC

The Playwright Planner Native Agent writes `specs/[story-id].md`
with each `SPEC-XXX` scenario carrying a metadata block or comment
referencing the `TC-XXX`(s) it implements.

The Generator reads the spec; preserving the `TC-XXX` reference
into the generated `.spec.ts` is a Gate 4 criterion (locator
stability + assertion correctness + traceability).

### 3.6 Every generated test references its spec and TC

The Playwright Generator Native Agent emits each `test(...)` block
with an annotation linking it to a `PW-XXX`, `SPEC-XXX`, and
`TC-XXX`. The recommended carrier is
`test.info().annotations.push({ type: 'TC', description: 'TC-001' })`,
which then appears in `reports/results.json` and feeds the Failure
Classifier's `test_case_id` linking.

For Phase 1, code comments at the top of each `test(...)` are
acceptable if the annotation pattern isn't used yet. Either way,
the link must be machine-recoverable — the Failure Classifier
should never have to guess.

### 3.7 Every Postman request references its TC (Phase 1.5+)

`COL-XXX → REQ-XXX → TC-XXX` (where the TC is one with
`automation_decision == "automate_api"`, also labelled `API-XXX`).
The reference goes in the request `description` or in a custom
metadata field on the request item.

### 3.8 Every failure references the test and the TC

`FAIL-XXX` always carries:

- `playwright_test_id` (`PW-XXX`) for Playwright failures, OR
- `request_id` (`REQ-XXX`) for Newman failures.
- `test_case_id` (`TC-XXX` / `API-XXX`) — the originating TC.

If a failure cannot be linked back to a TC (e.g. the seed test
fails), the failure carries `test_case_id: null` AND
`traceability_unresolved: true` with a human-readable reason. See
section 5.

### 3.9 Every Red failure produces a bug draft

`FAIL-XXX → BUG-XXX` is one-to-one for Red severity failures.
Green and Yellow failures do not produce bug drafts.

Each bug draft carries:

- `Linked Story` — `JIRA-XXX` / `STORY-XXX`.
- `Linked Failure` — `FAIL-XXX`.
- `Linked Risk` — `RISK-XXX` (from the originating TC's `risk_ids`;
  if multiple, list all).
- `Linked Test Case` — `TC-XXX` (or `API-XXX`).

These four lines are the bug draft's traceability header. Phase 2's
`scripts/create-jira-bugs.js` parses them.

### 3.10 Phase 2 — bug drafts → Jira issues

`scripts/create-jira-bugs.js --apply` reads each
`release/bug-drafts/BUG-XXX.md`, creates a Jira issue, and writes the
new key back into the draft's `Jira Issue Key` field. The link from
the new Jira issue back to the original Jira story (when one exists)
is created via Jira's issue-link types.

Re-running the script is safe — drafts with a non-empty `Jira Issue
Key` are skipped. That's the de-dup contract.

---

## 4. Coverage matrices (derived, not authored)

Two summary views are derived from the chain — they are not
separately maintained:

### 4.1 Risk coverage

For each `RISK-XXX` in `context.json.risks[]`:

- Which TCs (`test-cases/[story-id].json.test_cases[]`) reference it
  in their `risk_ids`?
- Which of those TCs are `approved` after Gate 2?
- Which `PW-XXX` / `REQ-XXX` map to those TCs?
- What was their last execution status (pass / fail / skipped)?

The Reporter emits this view as `release_report.json.coverage_by_risk[]`.
The schema for that field is in `schemas/release-report.schema.json`
(Phase 1 TG7).

**Explicit coverage gaps (Phase 2.6, Improvement 3).** The Reporter also
emits two derived fields so a zero-coverage risk is impossible to miss:
`uncovered_risks` (every `risk_id` whose `coverage_by_risk` status is
`uncovered`) and `uncovered_high_severity_count` (how many of those are
`high` severity). These are a deterministic query over the chain — no LLM.
A run with `uncovered_high_severity_count > 0` cannot be a `pass`
(`agents/reporter.md` §5.5/§6). The Spec Reviewer surfaces the same
gap earlier, at Gate 3 (`agents/spec-reviewer.md`).

### 4.2 AC coverage

For each AC (by index in `context.json.acceptance_criteria`):

- Which TCs reference it in `acceptance_criteria_refs`?
- Are they all `approved`?

AC coverage is checked at Gate 2 by the human reviewer; the Reporter
does not emit a separate matrix for it in Phase 1. Phase 3 (TG12)
may add it to the release report.

---

## 5. When a link cannot be established

Per `CLAUDE.md` section 3.4:

> If a link genuinely cannot be established, write
> `traceability_unresolved` with the reason. Don't fake links.

Concrete examples:

- **Seed test failure.** `tests/seed.spec.ts` is not associated with
  any TC. A failure on the seed is real (the environment broke) but
  has no `TC-XXX`. Record with `test_case_id: null` and
  `traceability_unresolved: true`, reason `"seed test — no TC"`.
- **Test running but no longer linked to a TC.** Should never happen
  in Phase 1 (the Generator wires it in), but if a developer
  hand-edits a test and removes its annotation, the Failure
  Classifier flags it.
- **Risk with no TC.** Either Gate 2 rejected this (preferred) or the
  team explicitly accepted the risk without testing. The accepted-
  without-test case must be written down somewhere — either in
  `context.json.risks[].description` ("accepted, reason: ...") or as
  a Gate 2 note (Phase 2 audit fields).

The point of `traceability_unresolved` is that downstream tooling
(reports, metrics, `/evolve`) can _see_ the gap. A faked link is
invisible until it causes a worse problem downstream.

---

## 6. Cross-run identity (Phase 3 preview)

Phase 1 runs one story at a time and overwrites the working
directory on each run. So `TC-001` for run A and `TC-001` for run B
on the same story are the same TC unless the Test Designer changed
it between runs.

Phase 3 (TG5) introduces `runs/[story-id]/[run-id]/...`. After that:

- A TC's global identity is `<story.id>::<run-id>::TC-XXX`.
- A FAIL's global identity is `<story.id>::<run-id>::FAIL-XXX`.
- The pipeline metrics script (Phase 3 TG6) walks completed runs and
  aggregates by `story.id` (collapsing run dimension) for trend
  analyses.

Within a single run, the short form (just `TC-XXX`) is always
unambiguous.

---

## 7. References

- `CLAUDE.md` section 3.4 — traceability as an operating principle.
- `README.md` section 4 — the chain as a project-level decision.
- `schemas/context.schema.json` — anchors `story.id` and `risks[]`
  (Phase 1 TG7).
- `schemas/test-cases.schema.json` — requires `risk_ids` on every TC
  (Phase 1 TG7).
- `schemas/failure-analysis.schema.json` — requires
  `test_case_id` + `playwright_test_id` (or `request_id`) on every
  failure (Phase 1 TG7).
- `schemas/release-report.schema.json` — derives `coverage_by_risk`
  (Phase 1 TG7).
- `skills/receiving-tickets/SKILL.md` — creates STORY/JIRA and
  RISK IDs.
- `skills/designing-cases/SKILL.md` — creates TC IDs.
- `skills/analyzing-logs/SKILL.md` — creates FAIL and BUG IDs.
- `docs/review-gates.md` — the gates that check traceability at each
  stage.
- `docs/pipeline-architecture.md` — the API ID extension and the `runs/`
  history layout.
