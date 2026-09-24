---
name: analyzing-logs
description: |
  Report phase. Reads the execution ledger and the pre-classifier's
  draft analysis (both derived from Playwright and, from Phase 1.5, Newman
  results), confirms the classification of every failure using the
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

If `context.json.review_gates.code_reviewed` is not passed (`true` or
`{ status: true }`), **stop**. Do not classify failures of code that has not
been through Gate 4. The approval must also be current: `npm run pipeline --
--status` must not report it stale. Approvals are bound to what they reviewed
(task group 4.3), so code changed after Gate 4 is code that has not been
reviewed.

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

- `analysis/execution-ledger.json` — **the counting model** (task group
  3.1). Every runner unit with exactly one outcome, attempts, nested Newman
  assertions and source-level errors. Totals come from here and are never
  recomputed from raw reports.
- `analysis/failure-analysis.json` — the pre-classifier's v2 **draft**
  (`npm run classify`), already holding every failed / blocked / flaky unit
  with a classification and the reason for it. This skill confirms and
  finalizes it.
- Raw reports under `reports/` (`results.json`,
  `reports/<execution-id>/newman/<story>/<collection>.json`) — evidence to
  read traces and screenshots from, not a source of counts.
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

| Classification               | Signals                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locator_or_selector`        | An ACTION (`locator.click`, `fill`, ...) timed out waiting for its locator; selector returns 0 elements; selector that worked previously now matches multiple. Not an assertion.        |
| `wait_or_timeout`            | A specific wait proven to be a timing problem (the right value arrives given more time). A bare `Test timeout of N exceeded` with no failing operation is `unknown_needs_human_review`. |
| `ui_structural_change`       | New page, new modal, removed control, navigation reorganized. Often surfaces as locator failure but the _cause_ is a real product change.                                               |
| `product_bug`                | A business assertion that the application failed on its own behavior. The test was right; the app is wrong.                                                                             |
| `test_bug`                   | The test made a wrong assumption — wrong expected value, wrong precondition, missing setup. The app is right; the test is wrong.                                                        |
| `flaky`                      | Same test passes on retry without code change. Not yet root-caused.                                                                                                                     |
| `environment_issue`          | Network failure, 5xx from a dependency, missing fixture, DNS, auth expired. Not a test bug and not a product bug — infrastructure.                                                      |
| `test_data_issue`            | The test's input data is no longer valid (account deleted, SKU removed, fixture drifted).                                                                                               |
| `unknown_needs_human_review` | Signals contradict each other or are insufficient. Default when confidence is low — never guess.                                                                                        |

For Newman/API failures (Phase 1.5+), additional rules of thumb:

- `status code mismatch (non-5xx)` on a business endpoint → likely
  `product_bug` (the API returned something other than what the AC
  said). Confirm by re-reading the AC and the request body.
- `5xx response` → likely `environment_issue` or `product_bug`;
  escalate to LLM judgment when ambiguous. Don't assume "server bug"
  if it might be a payload the test sent wrong.
- `timeout` → `unknown_needs_human_review` (Yellow); `flaky` only if a
  re-run of the same request passed.
- `post-response test script threw but response was 2xx and matches
the AC` → `test_bug`.

## Evidence order (task group 3.3)

Read what the error says actually FAILED — the operation on its first line
and its `Expected:` / `Received:` lines — never keywords anywhere in the
text. Strip terminal colour codes first: Playwright colours its matcher
hints, which silently defeated the old keyword rules. Apply in this order:

1. **Established business assertion mismatch** — a real value was observed
   and it is wrong → Red / `product_bug`. `expect(locator).toHaveText('$100.00')`
   against `$1.00` is Red, even though the message says "locator" (B1).
2. **Explicit infrastructure failure** (`net::ERR_*`, `ECONNREFUSED`, DNS,
   TLS) → Yellow / `environment_issue`.
3. **Retry-flaky outcome** → Yellow / `flaky`, unless any attempt meets 1.
4. **Proven locator failure during an action** → Green /
   `locator_or_selector` — only when no Red domain (`scripts/red-domains.js`)
   or semantic ambiguity is involved; otherwise Yellow.
5. **Anything uncertain** → Yellow / `unknown_needs_human_review`. This
   includes an element missing during an assertion (stale locator, or the
   product never rendered it?) and a whole-test timeout.

The rule-based pre-classifier (`scripts/lib/classify-failure.js`) applies
exactly this order and records its reason on each failure.

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
- Schema 2.x (what the pre-classifier and this skill write) also requires
  `execution_ledger`, `outcome_breakdown` (the ledger's unit outcomes; the
  flat totals above are its legacy projection) and `source_errors`.
- `failures[]` — each failure entry:
  - `failure_id` — `FAIL-001`, `FAIL-002`, ... ascending.
  - `unit_id`, `execution_outcome` (`failed` / `blocked` / `flaky` — what
    the run did, kept apart from the cause), `runner_identity`,
    `classification_reason` (2.x).
  - `test_case_id` — the originating `TC-XXX` (or `null` +
    `traceability_unresolved: true` if it cannot be linked).
  - `playwright_test_id` — `PW-XXX` for Playwright failures when proven
    from metadata; in 2.x `null` + `id_unresolved_reason` otherwise.
    Never derived from the order failures appear (B6).
  - `source` — `"playwright"` or `"newman"` (Phase 1.5+ adds the
    `"newman"` value via schema extension).
  - `request_id` — `REQ-XXX` for Newman failures; same rule as
    `playwright_test_id`.
  - `classification` — one of the taxonomy values above.
  - `severity` — `green` / `yellow` / `red`.
  - `error_message` — the raw message, trimmed.
  - `evidence_paths` — array of relative paths to traces, screenshots,
    Playwright HTML report sections, Newman response captures.
  - `bug_draft_path` — relative path to the bug draft, if one was
    created (Red failures only). In 2.x a `draft` never carries one for a
    draft that does not exist; `finalized` requires one for every Red.
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
2. **Read** the draft `analysis/failure-analysis.json` and its
   `execution_ledger`. If either is missing, run `npm run normalize` then
   `npm run classify` first — never classify from raw reports.
3. **Walk every failure in the draft.** For each:
   - Resolve the originating `TC-XXX` from exact metadata only (the test
     title `[TC-002]`, the request name `REQ-001 ... (TC-001)`, the test's
     annotations). Conflicting sources stay unresolved. If no match:
     `traceability_unresolved`.
   - Confirm or correct the classification per the evidence order above.
     Pull signals from the error message and the evidence paths first;
     only invoke LLM judgment for ambiguous cases. Update
     `classification_reason` when you change a call.
   - Mark severity Green/Yellow/Red per the table.
   - Keep the `FAIL-XXX` ID the pre-classifier assigned.
   - For Red failures: write `release/bug-drafts/BUG-XXX.md` and put
     the path in `bug_draft_path`.
4. **Do not recompute totals.** They are the ledger's; recomputing them is
   how timed-out tests vanished (B2) and pass counts went negative (B5).
5. **Finalize** `analysis/failure-analysis.json` (`status: "finalized"`)
   once every Red has its bug draft and every unresolved link is resolved
   or acknowledged. Validate.
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
- `analysis/execution-ledger.json` (the counts)
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
