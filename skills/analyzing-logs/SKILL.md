---
name: analyzing-logs
description: |
  Report phase. Reads Playwright execution results
  (reports/results.json) and, from Phase 1.5 onward, Newman API results
  (reports/newman-results.json), classifies every failure using the
  Failure Classifier taxonomy, marks Green/Yellow/Red severity per the
  Healer guardrails, and produces analysis/failure-analysis.json
  validated against schemas/failure-analysis.schema.json. For each Red
  failure, creates a bug draft in release/bug-drafts/BUG-XXX.md.
disable-model-invocation: true
adapted_from: dogkeeper886/ai-qa-workflow @ v3.0
adaptation_notes: |
  Original skill parsed Robot Framework output.xml / log.html. This
  pipeline runs Playwright (and Newman in P1.5+), so the inputs are the
  Playwright JSON reporter output and Newman's JSON reporter output.
  The taxonomy (locator/wait/UI structural / product bug / test bug /
  flaky / environment / test data / unknown) is new and ours; the source
  skill grouped failures more loosely. The Green/Yellow/Red severity
  marking and the bug-draft creation flow are new and tied to our
  Healer guardrails (`docs/healer-guardrails.md`).
tools:
  - Read
  - Glob
  - Grep
---

# analyzing-logs

**Phase:** 1+ (Playwright only). Phase 1.5+ adds Newman/API failures
to the same artifact.
**Owned by this skill:** the `agents/failure-classifier.md` agent uses
this skill to produce `analysis/failure-analysis.json` and bug drafts.
**Folder ownership:** writes only into `analysis/` and into
`release/bug-drafts/` (the Failure Classifier and Reporter share
ownership of `release/bug-drafts/`). Never modifies `tests/`,
`api-tests/`, `specs/`, `test-cases/`, or `planner-input/`.
**Gate upstream:** **Gate 4** must already be passed
(`context.json.review_gates.code_reviewed == true`). You only analyze
results of tests that humans have reviewed; analyzing failures from
un-reviewed code would invite the agent to "fix" tests it shouldn't
have shipped.

## Hard precondition

If `context.json.review_gates.code_reviewed != true`, **stop**. Do not
classify failures of code that has not been through Gate 4.

## What this skill produces

Two outputs:

1. `analysis/failure-analysis.json` — validated against
   `schemas/failure-analysis.schema.json`.
2. `release/bug-drafts/BUG-XXX.md` — one Markdown draft per Red
   failure. Phase 1 stops here (drafts only); Phase 2 adds optional
   promotion to real Jira issues via `scripts/create-jira-bugs.js
--apply`.

After writing, run:

```
node scripts/validate-json.js schemas/failure-analysis.schema.json analysis/failure-analysis.json
```

## Input sources

- `reports/results.json` — Playwright JSON reporter output (always
  present from Phase 1 onward).
- `reports/newman-results.json` — Newman JSON reporter output
  (Phase 1.5+, only if the story has `automate_api` test cases that
  produced an executed collection).
- `context.json` — for story metadata and traceability links.
- `test-cases/[story-id].json` — to map executed tests back to the
  `TC-XXX` that originated them.
- `api-tests/collections/[story-id].postman_collection.json` (Phase 1.5+)
  — to map Newman requests back to `REQ-XXX` and `API-XXX`.

If a Playwright test cannot be linked to a `TC-XXX` (e.g. the seed
test), record the failure with `test_case_id: null` and
`traceability_unresolved: true` in the failure entry. Do not fabricate
a link.

## Failure classification taxonomy

Every failure is classified into exactly one of these categories
(canonical list lives in `schemas/failure-analysis.schema.json`):

| Classification               | Signals                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locator_or_selector`        | `TimeoutError: locator(...)` waiting for an element; selector returns 0 elements; selector that worked previously now matches multiple.                               |
| `wait_or_timeout`            | `Test timeout of N exceeded`; assertion timeout where the value would have been correct given more time; flaky-looking timing without a deterministic root cause yet. |
| `ui_structural_change`       | New page, new modal, removed control, navigation reorganized. Often surfaces as locator failure but the _cause_ is a real product change.                             |
| `product_bug`                | A business assertion that the application failed on its own behavior. The test was right; the app is wrong.                                                           |
| `test_bug`                   | The test made a wrong assumption — wrong expected value, wrong precondition, missing setup. The app is right; the test is wrong.                                      |
| `flaky`                      | Same test passes on retry without code change. Not yet root-caused.                                                                                                   |
| `environment_issue`          | Network failure, 5xx from a dependency, missing fixture, DNS, auth expired. Not a test bug and not a product bug — infrastructure.                                    |
| `test_data_issue`            | The test's input data is no longer valid (account deleted, SKU removed, fixture drifted).                                                                             |
| `unknown_needs_human_review` | Signals contradict each other or are insufficient. Default when confidence is low — never guess.                                                                      |

For Newman/API failures (Phase 1.5+), additional rules of thumb:

- `status code mismatch (non-5xx)` on a business endpoint → likely
  `product_bug` (the API returned something other than what the AC
  said). Confirm by re-reading the AC and the request body.
- `5xx response` → likely `environment_issue` or `product_bug`;
  escalate to LLM judgment when ambiguous. Don't assume "server bug"
  if it might be a payload the test sent wrong.
- `timeout` → `wait_or_timeout`.
- `post-response test script threw but response was 2xx and matches
the AC` → `test_bug`.

## Green / Yellow / Red severity

Independent of the classification above, each failure also gets a
severity per `docs/healer-guardrails.md`:

| Severity   | Definition                                                                                                                       | Phase 1 action                                                            | Phase 3 action                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Green**  | Locator broken, wait unstable, timeout stabilization, minor selector refactor that preserves business meaning.                   | Document in `failure-analysis.json`. Phase 1 takes no auto-fix action.    | Healer may generate a reviewable `.patch` (never a direct commit). |
| **Yellow** | UI structural change, new modal, layout reorganization. Behavior may still be valid; needs a human to decide.                    | Document. No fix.                                                         | Healer writes a suggestion only; human must approve.               |
| **Red**    | Business assertion, permission/role, security, pricing, payment, compliance, data integrity, or any change in assertion meaning. | Document AND create `release/bug-drafts/BUG-XXX.md`. Never propose a fix. | Same as Phase 1 — bug draft only.                                  |

**Newman/API failures are never touched by the Healer** in any phase
(plan-wide rule). Treat all API failures as bug-draft-or-document only.

## Required `failure-analysis.json` shape (schema-bound)

Defined in `schemas/failure-analysis.schema.json`. Top-level required:

- `schema_version`, `run_id`, `story_id`, `execution_date` (ISO).
- `total_tests`, `passed`, `failed`, `skipped`.
- `failures[]` — each failure entry:
  - `failure_id` — `FAIL-001`, `FAIL-002`, ... ascending.
  - `test_case_id` — the originating `TC-XXX` (or `null` +
    `traceability_unresolved: true` if it cannot be linked).
  - `playwright_test_id` — `PW-XXX` for Playwright failures.
  - `source` — `"playwright"` or `"newman"` (Phase 1.5+ adds the
    `"newman"` value via schema extension).
  - `request_id` — `REQ-XXX` for Newman failures (Phase 1.5+, optional).
  - `classification` — one of the taxonomy values above.
  - `severity` — `green` / `yellow` / `red`.
  - `error_message` — the raw message, trimmed.
  - `evidence_paths` — array of relative paths to traces, screenshots,
    Playwright HTML report sections, Newman response captures.
  - `bug_draft_path` — relative path to the bug draft, if one was
    created (Red failures only).
- `status` — `draft` while in progress, `finalized` once the human
  agrees the classification is right and the bug drafts are ready for
  Phase 2 promotion.

## Bug draft format

Phase 2 `docs/bug-draft-format.md` defines the exact format that
`scripts/create-jira-bugs.js` will later parse. In Phase 1, just
follow the same structure so the format is stable:

```markdown
# BUG-XXX

## Summary

[Brief description]

## Severity

red

## Linked Story

[story.id]

## Linked Failure

FAIL-XXX

## Linked Risk

RISK-XXX (from the originating TC's risk_ids)

## Linked Test Case

TC-XXX (or API-XXX for Phase 1.5+ API failures)

## Steps to Reproduce

1. ...

## Expected Behavior

[From the AC / TC.expected_results]

## Actual Behavior

[Observed]

## Environment

[BASE_URL, browser, run_id]

## Evidence

- reports/...
- traces/...

## Jira Issue Key

(empty — populated by Phase 2 `scripts/create-jira-bugs.js --apply`)
```

The `Jira Issue Key` line MUST be present and empty in Phase 1. Phase 2
parses it; an entry that already has a key is skipped (de-dup safety).

## Steps

1. **Verify Gate 4** is passed. Stop otherwise.
2. **Read** `reports/results.json` (and `reports/newman-results.json`
   in P1.5+).
3. **Walk every failed test.** For each:
   - Find the originating `TC-XXX` by reading the test file's metadata
     comments or matching the test name against
     `test-cases/[story-id].json`. If no match: `traceability_unresolved`.
   - Classify per the taxonomy above. Pull signals from the error
     message and the evidence paths first; only invoke LLM judgment
     for ambiguous cases.
   - Mark severity Green/Yellow/Red per the table.
   - Assign a `FAIL-XXX` ID.
   - For Red failures: write `release/bug-drafts/BUG-XXX.md` and put
     the path in `bug_draft_path`.
4. **Aggregate.** Compute totals.
5. **Write** `analysis/failure-analysis.json`. Validate.
6. **Update** `context.json.artifact_paths.failure_analysis`. Re-validate.

## What this skill does NOT do

- **Modify tests, specs, or any source code.** Healer guardrails. Even
  for Green failures, this skill only documents; in Phase 3 the
  separate Healer flow does the patching.
- **Decide release pass/fail.** That's the Reporter (`agents/reporter.md`).
- **Promote bug drafts to real Jira.** That's Phase 2's
  `scripts/create-jira-bugs.js --apply`, gated by explicit human flag.
- **Re-run failed tests.** Phase 3's controlled Healer re-runs the
  affected test in an isolated workspace after a patch; this skill
  does not.

## When to STOP and ask

- A failure cannot be classified with reasonable confidence after
  weighing all signals → use `unknown_needs_human_review`. Do not
  guess. Mark it Yellow (default for unknown) so it gets human eyes.
- A failure looks Red (business assertion broken) but the AC is
  ambiguous → record in `context.json.ambiguities`, mark the failure
  `unknown_needs_human_review`, and stop. Do not declare a product
  bug against an ambiguous spec.
- The reports file references tests that have no corresponding
  `TC-XXX` and aren't the seed test → that's a missing-link signal.
  Document with `traceability_unresolved: true` and surface to the
  human.

## Hand-off to the Reporter

`agents/reporter.md` reads:

- `context.json`
- `test-cases/[story-id].json`
- `analysis/failure-analysis.json` (this skill's output)
- `reports/results.json` (+ `reports/newman-results.json` in P1.5+)
- The bug drafts under `release/bug-drafts/`

and produces `release/release-report.md` + `release/release-report.json`.

The Reporter does NOT re-classify. If you need a different
classification later, re-run this skill, not the Reporter.

## References

- `schemas/failure-analysis.schema.json` — the binding schema (created
  in Phase 1 TG7).
- `docs/healer-guardrails.md` — Green/Yellow/Red definitions (created
  in Phase 1 TG6).
- `docs/review-gates.md` — Gate 4 precondition (created in Phase 1 TG6).
- `docs/traceability.md` — full chain; this skill creates the FAIL
  layer and seeds the BUG layer (created in Phase 1 TG6).
- `docs/bug-draft-format.md` — bug draft template parsed by Phase 2
  (created in Phase 2 TG5; the format is stable from Phase 1).
- `agents/failure-classifier.md` — the agent prompt that calls this
  skill (created in Phase 1 TG10).
- `agents/reporter.md` — the downstream consumer (created in
  Phase 1 TG10).
