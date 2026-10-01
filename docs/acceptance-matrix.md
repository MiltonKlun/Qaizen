# Acceptance matrix

Each scenario below is the end-to-end behavior the pipeline must show, and the
regression tests that demonstrate it. Every test runs in `npm run test:pipeline`
on Ubuntu and Windows in CI (`.github/workflows/qa-pipeline.yml`, the
`pipeline-tests` job), browser-backed ones included.
`test/acceptance-matrix.test.js` fails if a test named here is renamed or
removed, so the matrix cannot silently go stale.

None of these tests approves a real gate. They use temporary workspaces, local
fake services and synthetic reviewed artifacts; the runner's own approval
entry point still refuses non-interactive input (`test/run-pipeline.test.js`).

## 1. Business-value mismatch with locator text

A failed unit is kept, classified Red, never eligible for the Healer, and still
blocks the release.

- `test/failure-classifier.test.js`: "B1: a wrong business value is Red, not a locator problem"
- `test/failure-classifier.test.js`: "... unless a failed attempt showed a wrong business value (stronger Red cause)"
- `test/run-healer.test.js`: "refused before anything runs: changed original, wrong failure, Yellow, API, or the live file as candidate"
- `test/evaluate-agents.test.js`: "the reporter stage scores a release report against its own run"

## 2. Playwright timeout or global setup failure

The failure or the run-level error is kept; nothing reads as a pass; the
runner does not loop on the executor.

- `test/execution-results.test.js`: "a timed-out test is a failure, not a silent disappearance (B2)"
- `test/execution-results.test.js`: "report-level errors survive even when no tests ran"
- `test/execution-paths.test.js`: "run-level errors dominate the verdict"
- `test/execution-paths.test.js`: "reports with zero counted units warn instead of reporting success"
- `test/run-transitions.test.js`: "B4: a runner that produces no report stops after ONE launch"

## 3. Newman connection failure before assertions

The request is blocked, counters stay nonnegative, the analysis is valid, and
no business coverage passes.

- `test/execution-results.test.js`: "a transport error is blocked, not a business failure"
- `test/execution-results.test.js`: "transport errors are never subtracted from assertion totals (B5)"
- `test/execution-results.test.js`: "newmanOutcome checks transport before assertions"
- `test/failure-classifier.test.js`: "Newman: transport, zero assertions, failed assertions; nothing is Green"
- `test/execution-results.test.js`: "a case passes only when every linked unit strictly passed"

## 4. First API collection fails, the second passes

Both reports are kept, the aggregate keeps the failure, and neither
overwrites the other.

- `test/execution-paths.test.js`: "an earlier failure survives a later passing collection, in both orders"

## 5. A synthetic secret in headers, variables or error text

Raw local output may keep it; every published file omits it.

- `test/report-sanitization.test.js`: "published view omits the secret in every location Newman records it"
- `test/execution-results.test.js`: "no secret survives into adapter output or the assembled ledger"
- `test/execution-paths.test.js`: "run-newman writes per-execution paths and publishes nothing on failure"

## 6. A new story after a completed one

The old run is archived and preserved; the new run has a new identity, starts
at the Analyst, and inherits no approval.

- `test/run-lifecycle.test.js`: "B3: a new story after a COMPLETED run archives it and reaches the Analyst"
- `test/run-lifecycle.test.js`: "a new story never replaces an INCOMPLETE run, and nothing is written"
- `test/run-lifecycle.test.js`: "archived artifacts are NOT reformatted: the bytes match the source"

## 7. An invalid, stale or wrong-run artifact

Resume refuses to progress before any prompt or execution; `--status` only
reads.

- `test/run-transitions.test.js`: "an artifact from another story or run does not count"
- `test/run-transitions.test.js`: "an invalid context.json stops the runner before any step"
- `test/run-transitions.test.js`: "a gate does not prompt when an input it reviews is invalid"
- `test/run-transitions.test.js`: "a stale report (older than the test it ran) is not accepted"
- `test/run-transitions.test.js`: "--status reports invalid artifacts and never writes"

## 8. A test, spec or case edited after approval

The right gate and every gate after it go stale; the decision history is
kept.

- `test/approval-binding.test.js`: "a changed expected value makes Gate 2 stale, and every later gate with it"
- `test/approval-binding.test.js`: "a changed test or dependency lock makes Gate 4 stale only"
- `test/approval-binding.test.js`: "resume returns stale approvals to pending, records why, keeps the history"

## 9. A remote id added after the scope review

The scope review stays valid: writing back an identity is not a semantic
change.

- `test/approval-binding.test.js`: "adding a Jira id or sync record, reformatting, or CRLF line endings changes nothing"

## 10. A Jira create succeeds and a later action fails

The created id persists, resume never recreates it, and an uncertain create
waits for reconciliation.

- `test/external-sync.test.js`: "first create succeeds, second is rejected: the first key survives and is never recreated"
- `test/external-sync.test.js`: "remote success with a lost response: pending blocks creates until --reconcile finds it"
- `test/external-sync.test.js`: "a failed story link keeps the key; the next run retries only the link"

## 11. An existing TestLink case synced again

It is skipped: zero create calls, and its id does not change.

- `test/external-sync.test.js`: "TestLink: the review fixture — already-linked cases make zero create calls and keep their ids"
- `test/external-sync.test.js`: "repeating a successful sync creates nothing and changes nothing (Jira and TestLink)"

## 12. A manual, skipped or unexecuted case

Not Run or Blocked as defined; never Pass without reviewed positive evidence.

- `test/execution-sync.test.js`: "manual, skipped and no-result cases are Not Run; a fully covered passing case is Pass; API is withheld"
- `test/external-branch.test.js`: "an absent manual result stays Not Run: nothing is inferred from silence"
- `test/execution-results.test.js`: "a nonempty approved scope with zero executed units has zero coverage"

## 13. A forbidden or ambiguous Healer candidate

Rejected, the live file unchanged, and the attempt's evidence kept.

- `test/run-healer.test.js`: "a statically rejected candidate is recorded without running anything"
- `test/run-healer.test.js`: "a candidate that still fails, skips, or runs no single test is validation_failed"
- `test/healer-guardrails.test.js`: "S1: negating a matcher is rejected"
- `test/healer-guardrails.test.js`: "S2: adding .skip is rejected even when the file already skips something"

## 14. An eligible Healer candidate

The exact affected unit is verified, a real patch is produced, and human
approval is still pending.

- `test/run-healer.test.js`: "a validated candidate yields a patch that reproduces it, plus evidence; the live test is untouched"
- `test/run-healer.test.js`: "real Playwright: a broken locator is healed against the demo app"

## 15. API-only, manual-only, skip-only and mixed scopes

Each branch gets its own reviews and evidence; no fictional E2E artifact or
borrowed approval.

- `test/api-branch.test.js`: "API-only: its own reviews in order, no E2E step, no borrowed approval"
- `test/api-branch.test.js`: "a mixed scope does not execute either suite until every branch is reviewed"
- `test/external-branch.test.js`: "manual pass with evidence: recorded with its digest, approves nothing, then classified as passed"
- `test/external-branch.test.js`: "a skip-only scope passes both external reviews and yields an explicit zero-execution ledger"
- `test/external-branch.test.js`: "a mixed manual/API scope reviews every plan before Newman, and the evidence after it"

## 16. A missing evaluation candidate

A nonzero exit with the missing artifact named; never a reduced-denominator
100%.

- `test/false-success.test.js`: "evaluate-agents: a missing candidate directory fails (never a silent 0 stories, exit 0)"
- `test/evaluate-agents.test.js`: "a declared Designer output that is missing fails, and stays in the report"
- `test/evaluate-agents.test.js`: "a reporter candidate without its release report is missing work, not a score"

## 17. Ten rejected runs, or missing prompt provenance

The JSON and the Markdown agree on not met or not computable.

- `test/pipeline-metrics.test.js`: "ten rejected runs never render as met"
- `test/pipeline-metrics.test.js`: "zero eligible runs: no cohort, no verdict"
- `test/pipeline-metrics.test.js`: "mixed prompt versions are separate cohorts, never pooled into one verdict"

## 18. Two stories with TC-001; a Yellow Healer note

Separate case metrics, and no fictitious validated patch.

- `test/pipeline-metrics.test.js`: "two stories sharing a TC id stay two rows, each naming its runs"
- `test/pipeline-metrics.test.js`: "Yellow-only, legacy-only or invalid evidence leaves the rate unknown, not 100%"

## 19. Named-locator drift or an ambiguous match

The probe fails survival as it should; a measurement that cannot be made stays
null.

- `test/selector-survival.test.js`: "real locator semantics decide survival: named-role drift, strictness, scope, and non-text locators"
- `test/selector-survival.test.js`: "a baseline probe that is not unique makes the measurement invalid, not a failure rate"
- `test/selector-survival.test.js`: "one version only, repeated versions, or an invalid probe module never produce a rate"
