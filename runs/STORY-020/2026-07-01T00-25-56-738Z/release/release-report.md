# Release Report — STORY-020: Checkout order summary shows the correct item total, tax, and total

**Run ID:** 2026-06-30T21-00-00Z-checkoutsummary
**Report date:** 2026-07-01
**Recommendation:** pass — all five E2E cases pass; every risk covered and passing.

## Summary

STORY-020 (checkout order summary) was driven through all four gates by the
**real Playwright Native Agents** (Planner + Generator). Five `automate_e2e`
cases were generated against the running SauceDemo app: the two-step checkout
journey, the two money-math guarantees, a missing-field validation case, and the
finish/confirmation flow. All five pass on first execution — no healing needed.
The money-math cases read live rendered values and assert computed relationships
in integer cents; **no hard-coded price constants**.

## Coverage by risk

| Risk     | Severity | Covered by     | Status          |
| -------- | -------- | -------------- | --------------- |
| RISK-001 | high     | TC-002         | covered_passing |
| RISK-002 | high     | TC-003         | covered_passing |
| RISK-003 | medium   | TC-004         | covered_passing |
| RISK-004 | medium   | TC-001, TC-005 | covered_passing |

## Coverage gaps

- **Uncovered risks:** none
- **Uncovered high-severity:** 0

## Execution summary

- Total: 5
- Passed: 5
- Failed: 0
- Skipped: 0
- Pass rate: 100%

## Blocking failures

- none

## Non-blocking failures

- none

## Bug drafts

- none

## Recommendation

**pass.** All five E2E test cases pass; all four risks are covered_passing; zero
uncovered high-severity risks and zero bug drafts. The two money-math guarantees
are pinned by TC-002 and TC-003, which read the rendered prices/tax/total live
and assert their arithmetic in integer cents (no hard-coded constants) — so a
wrong item total or an inconsistent total would fail the run. No healing was
required; every test passed on first execution.

## Open questions

- none

## Evidence

- reports/html
- reports/results.json
- analysis/failure-analysis.json
