# Release Report — SK-13: As a user I want to sort products by name and price

**Run ID:** `2026-06-04T16-00-00Z-sk13`
**Report date:** 2026-06-04T17:05:00Z
**Recommendation:** **pass** — all four sort modes + active-selection check green; all risks covered_passing.

## Summary

SK-13 (fetched from Jira via Mode B) is an E2E-only slice against Saucedemo —
sorting is client-side, so there is no backend sort API to assert against.
Five tests cover the four sort modes (Name A→Z, Name Z→A, Price low→high,
Price high→low) plus the active-selection-visible check, and all passed live
with 0 failures and 0 bug drafts. The price-sort assertions compare prices as
numbers (not strings) to guard against the classic "$10 before $9" ordering
bug (RISK-002). Sort behaviour and locators were verified live via the
playwright-test MCP before the test was written.

## Coverage by risk

| Risk     | Severity | Covered by                     | Status          |
| -------- | -------- | ------------------------------ | --------------- |
| RISK-001 | high     | TC-001, TC-002, TC-003, TC-004 | covered_passing |
| RISK-002 | medium   | TC-003, TC-004                 | covered_passing |
| RISK-003 | low      | TC-005                         | covered_passing |

## Execution summary

- Total: 5
- Passed: 5
- Failed: 0
- Skipped: 0
- Pass rate: 100%

(E2E-only story — Saucedemo sorts client-side — so the flat execution summary
is used.)

## Blocking failures

- None.

## Non-blocking failures

- None.

## Bug drafts

- None (no Red failures).

## Recommendation

**pass.** All three risks are covered_passing. RISK-001 (wrong sort order) is
covered by TC-001–TC-004; RISK-002 (price-as-string ordering) is specifically
guarded by the numeric price comparisons in TC-003/TC-004; RISK-003
(active selection not shown) is covered by TC-005. No blocking failures, no
flakes, no skipped or unexecuted cases.

## Open questions

- None.

## Evidence

- reports/html
- reports/results.json
- analysis/failure-analysis.json
