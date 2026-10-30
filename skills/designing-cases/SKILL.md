---
name: designing-cases
description: |
  Design phase. Reads context.json (post-Gate-1) and produces
  test-cases/[story-id].json validated against
  schemas/test-cases.schema.json. Every test case carries a traceability
  link to one or more RISK-XXX, a priority, a test-level recommendation,
  and an Automation Decision (automate_e2e / automate_api /
  automate_component / manual / skip) with a written reason.
disable-model-invocation: true
adapted_from: dogkeeper886/agent-workflows @ v3.0 (989343d; the repository was formerly dogkeeper886/ai-qa-workflow)
adaptation_notes: |
  Original skill writes per-scenario Markdown files (TS-XX_*.md) and
  publishes them to Confluence. Our output is a single JSON artifact
  (test-cases/[story-id].json) validated against a binding schema.
  The Automation Decision Model — including its explicit rejection of
  "everything is E2E" — is a non-negotiable rule in this pipeline that
  the original skill does not have. The Confluence publish and the
  /tw-case-* slash commands are not used.
tools:
  - Read
  - Glob
  - Grep
---

# designing-cases

**Phase:** 1+
**Owned by this skill:** the `agents/test-designer.md` agent uses this
skill (together with `planning-tests`) to produce
`test-cases/[story-id].json`.
**Folder ownership:** writes only into `test-cases/`. Never touches
`planner-input/` (that's `planning-tests`), `specs/` (Playwright Planner),
`tests/` (Playwright Generator), `api-tests/` (API Agent),
`analysis/`, or `release/`.
**Gate upstream:** **Gate 1** must already be passed
(`context.json.review_gates.requirements_reviewed == true`).
**Gate downstream:** **Gate 2 — Test Scope Approval** runs after this skill
_and_ `planning-tests` both complete.

## Hard precondition

If `context.json.review_gates.requirements_reviewed != true`, **stop**.
Same rule as `planning-tests`. Do not design cases against unreviewed
ambiguities.

## What this skill produces

A single file: `test-cases/[story-id].json`, where `[story-id]` is
`context.json.story.id`.

It MUST validate against `schemas/test-cases.schema.json`. After writing
it, run:

```
node scripts/validate-json.js schemas/test-cases.schema.json test-cases/[story-id].json
```

If validation fails, fix and re-validate before requesting Gate 2.

## Test case shape (schema-bound)

The full shape is defined by `schemas/test-cases.schema.json`. Every
test case includes:

- `test_case_id` — `TC-001`, `TC-002`, ... unique within this file.
- `title`, `description`.
- `risk_ids` — at least one `RISK-XXX` from `context.json.risks`.
  This is the single most important field. A test case with no risk
  link is not a test case in this pipeline; it's noise.
- `acceptance_criteria_refs` — which AC(s) this case validates.
- `priority` — `P0` / `P1` / `P2` / `P3`.
- `test_level_recommendation` — `unit` / `component` / `integration` /
  `e2e` / `api`.
- `automation_decision` — see below.
- `automation_decision_reason` — **required free text**. Why this
  decision, not another. Missing or generic ("because UI") is a Gate 2
  rejection.
- `preconditions`, `steps`, `expected_results`.
- `status` — `draft` initially. The human flips it to `approved` or
  `rejected` during Gate 2.
- `qmetry_fields` — optional, unused. Reserved.
- `testlink_id` — optional, populated by the TestLink sync.

The schema also has an optional `api_metadata` object for
`automation_decision == "automate_api"` (method, endpoint, expected status
codes, etc.). This skill does not populate it — leave the field out entirely.

## The Automation Decision Model (mandatory)

This is the most-policed rule of this skill. Every test case MUST get
exactly one decision and a real reason. See
`docs/automation-decision-model.md` for the canonical list.

| Decision             | Use when                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automate_e2e`       | High-value user journey, smoke/regression critical, UI-critical flow that an API call cannot validate.                                                                        |
| `automate_api`       | Business logic / validations / permissions / filtering / data-heavy checks that don't need UI verification. The API Agent turns these into a Postman collection after Gate 2. |
| `automate_component` | UI state below the E2E level — a single component in isolation.                                                                                                               |
| `manual`             | Exploratory, usability, subjective visual, accessibility review with human judgment.                                                                                          |
| `skip`               | Low-risk, duplicate of another case, or out-of-scope. The `automation_decision_reason` must explain which other case covers it or why it is out of scope.                     |

**The "everything is E2E" failure mode:** if your case list is more
than ~60% `automate_e2e`, stop and re-evaluate. Most validation logic,
permission checks, and data shape checks belong at the API level. The
Gate 2 reviewer is instructed to push back on E2E-heavy lists.

## Test design techniques (name the one behind each case)

Derive cases with a technique, not by intuition, and name it: the case's
`description` starts with the technique in brackets, e.g.
`[Boundary value] A card expiring in the current month is accepted.` A
case two techniques produced names both: `[Decision table, Boundary value]`.

| Technique             | Use it when an acceptance criterion...                                  | It gives you                                                     |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Use case              | describes a user journey                                                | the main flow, and each alternate or error flow the story names  |
| Equivalence partition | takes an input whose values fall into classes that behave alike         | one case per class; each invalid class on its own                |
| Boundary value        | has a range, a limit or a date (quantity 1–99, an expiry month)         | cases on each boundary and just outside it                       |
| Decision table        | combines conditions into different outcomes (member × amount × coupon)  | one case per rule that changes the outcome                       |
| State transition      | moves something between states (cart empty → filled, order paid)        | the valid transitions, and at least one invalid one              |
| Error guessing        | has a known way to fail: the defect a bug-fix story reports, a past bug | a case aimed squarely at that failure                            |
| Checklist             | must meet an external standard (accessibility: WCAG 2.1 A and AA)       | one case per page or state the story changes, checked against it |

The first four are the ISTQB black-box techniques; use case covers the
journeys, error guessing the known failures, and checklist a standard the
page must meet. Consider them all for every
AC and use the ones that fit; most stories need two or three. A boundary or
an invalid class the story leaves undefined is an ambiguity, not a guess.

### Accessibility cases

When an acceptance criterion or a risk concerns accessibility (keyboard use,
screen readers, labels, contrast, a public or regulated page), design a
`[Checklist]` case for each page or state the story changes: `automate_e2e`,
expected result "no WCAG 2.1 A or AA violation". The planner brief tells the
Planner and Generator to open the page in that state and call
`expectAccessible` from `tests/fixtures/accessibility.ts`. Do not add one to
a story that does not concern accessibility; that is the team's call, not a
default.

## Traceability rules

- Every `TC-XXX` MUST reference at least one `RISK-XXX` from
  `context.json.risks`. The reverse direction does not have to be
  exhaustive (a risk may be addressed by multiple TCs, or — with
  written justification — by no TC if the risk is accepted).
- `TC-XXX` IDs are unique within `test-cases/[story-id].json`. Across
  stories they may collide; the global identity is
  `<story.id>::TC-XXX`.
- If a test case cannot be traced to any risk, do not invent a risk.
  Stop, report, and either add the risk in `context.json` (which
  re-opens Gate 1) or drop the case.

After writing, update `context.json.artifact_paths.test_cases` to the
relative path of the new file, then re-validate `context.json`.

## Steps

1. **Read inputs** — `context.json`, `planner-input/[story-id].planner-brief.md`
   if `planning-tests` already ran (recommended ordering: brief first,
   then cases). Both are fine in either order as long as both finish
   before Gate 2.
2. **Walk the acceptance criteria.** For each AC, list the test cases
   that would validate it. Multiple ACs may share a case; a single AC
   may need multiple cases (happy path + negative variants).
3. **Walk the risks.** For each RISK-XXX, confirm at least one TC
   references it. If a high-severity risk has no test, flag in
   `context.json.ambiguities` and stop — do not silently leave it
   uncovered.
4. **Apply the test design techniques** (the table above). For each AC,
   decide which techniques fit: its journeys (use case), its input classes
   (equivalence partition), its limits (boundary value), its combined
   conditions (decision table), its states (state transition) and its known
   failures (error guessing, always for a bug-fix story). Add the cases they
   give, including the negative inputs and permission variants, and name the
   technique at the start of each case's `description`.
5. **Apply the Automation Decision Model** to every case. Write the
   reason. Sanity-check the distribution — if everything is `automate_e2e`,
   redistribute.
6. **Assign priorities** based on risk severity + AC importance, not
   on personal preference.
7. **Write `test-cases/[story-id].json`.** Validate. Re-validate.
8. **Update** `context.json.artifact_paths.test_cases`. Re-validate
   `context.json`.

## Out-of-scope work (do not do here)

- Writing the planner brief (→ `planning-tests`).
- Producing Playwright specs (→ Playwright Planner, after Gate 3 setup).
- Producing Playwright tests (→ Playwright Generator, after Gate 4).
- Producing Postman collections (→ `agents/api-agent.md`).
- Publishing to Confluence — not in this pipeline.
- Sync to TestLink (→ `syncing-testlink`).
- Modifying the schema (`schemas/test-cases.schema.json`). If you need
  a field that doesn't exist, that's the Architecture Stability Rule
  scenario (`CLAUDE.md` section 3.10). Stop, propose the change.

## When to STOP and ask

- A risk has no test and you cannot honestly justify accepting it.
- An acceptance criterion cannot be validated by any practical test.
- The Automation Decision Model gives you nothing reasonable — every
  decision feels wrong. This usually means the story is split across
  layers (UI + API + workflow) without a clear seam.
- Schema validation fails for a reason the data alone cannot fix.

Record blockers in `context.json.ambiguities` with `blocking: true`,
stop, and surface to the human.

## Gate 2 hand-off

Gate 2 criteria (from `docs/review-gates.md`):

- Risk coverage is complete (every meaningful risk has at least one
  TC, or has an explicit accepted-without-test note).
- Priorities are reasonable.
- Automation decisions are justified — no "everything is E2E", no
  generic reasons.
- Low-value cases are explicitly marked `manual` or `skip` with reason.

Before approving, the human sets each TC's `status` to `"approved"` or
`"rejected"` (the runner refuses Gate 2 while any case is still `draft`),
then records the decision in `npm run pipeline`. The runner writes
`review_gates.test_scope_reviewed`, bound to the reviewed test cases; no
person or agent sets it by hand.

On rejection: re-run with corrections. Do not bypass.

## Next step

After Gate 2 passes:

- Playwright Planner Native Agent runs against
  `planner-input/[story-id].planner-brief.md` + `tests/seed.spec.ts` and
  produces `specs/[story-id].md`. Then Gate 3.
- The API Agent (`agents/api-agent.md`) reads the subset of
  TCs marked `automate_api` and produces
  `api-tests/collections/[story-id].postman_collection.json`. Then a
  parallel Gate 3 / Gate 4 for the API branch.

## References

- `schemas/test-cases.schema.json` — the binding schema.
- `docs/automation-decision-model.md` — the five decisions and when to
  use each.
- `docs/review-gates.md` — Gate 1 precondition and Gate 2 criteria.
- `docs/traceability.md` — full chain; this skill creates the TC layer.
- `agents/test-designer.md` — the agent prompt that orchestrates this
  skill and `planning-tests`.
