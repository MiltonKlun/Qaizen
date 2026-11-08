# REG-006 — Test Designer

**Where it comes from (bench-shop-bug).** Bench Shop --bug stale-badge: the basket count does not go down on a take-out until the shopper changes screen (BENCH-1, RISK-001).

**Expected behavior.** An automated case covers the basket count going down right after a take-out, without a change of screen, so a test can catch the stale count.

## Running a trial

Run the Test Designer (`agents/test-designer.md`) on `context.json` and `story.md`, as after an approved Gate 1, and keep the test cases it writes. Do not run the gates.

Trial output: `test-cases.json` (the `test-cases/<story-id>.json` the agent wrote).

Checks: `test_cases_valid`, `automated_case_for_criterion` (`scripts/lib/regression-checks.js`).
