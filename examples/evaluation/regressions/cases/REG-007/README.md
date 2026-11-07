# REG-007 — Test Designer

**Where it comes from (bench-shop-bug).** Bench Shop --bug wrong-item-total and --bug inconsistent-total: the overview item total is off by $1.00, or the total is not item total plus tax (STORY-020, RISK-001 and RISK-002).

**Expected behavior.** Automated cases cover both the item total being the sum of the line prices and the total being the item total plus tax.

## Running a trial

Run the Test Designer (`agents/test-designer.md`) on `context.json` and `story.md`, as after an approved Gate 1, and keep the test cases it writes. Do not run the gates.
Trial output: `test-cases.json` (the `test-cases/<story-id>.json` the agent wrote).

Checks: `test_cases_valid`, `automated_case_for_criterion`, `automated_case_for_criterion` (`scripts/lib/regression-checks.js`).
