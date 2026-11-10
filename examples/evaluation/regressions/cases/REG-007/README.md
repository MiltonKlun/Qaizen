# REG-007 — Test Designer

**Where it comes from (bench-shop-bug).** Bench Shop --bug wrong-item-total and --bug inconsistent-total: the review's Items figure is off by $1.00, or the Order total is not Items plus Sales tax (BENCH-2, RISK-001 and RISK-002).

**Expected behavior.** Automated cases cover both the Items figure being the sum of the basket prices and the Order total being Items plus Sales tax.

## Running a trial

Run the Test Designer (`agents/test-designer.md`) on `context.json` and `story.md`, as after an approved Gate 1, and keep the test cases it writes. Do not run the gates.

Trial output: `test-cases.json` (the `test-cases/<story-id>.json` the agent wrote).

Checks: `test_cases_valid`, `automated_case_for_criterion`, `automated_case_for_criterion` (`scripts/lib/regression-checks.js`).
