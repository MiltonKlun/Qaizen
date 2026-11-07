# REG-006 — Test Designer

**Where it comes from (bench-shop-bug).** Bench Shop --bug stale-badge: the cart badge does not count down on a remove until a reload (STORY-003, RISK-001).

**Expected behavior.** An automated case covers the badge counting down right after a remove, without a reload, so a test can catch the stale badge.

## Running a trial

Run the Test Designer (`agents/test-designer.md`) on `context.json` and `story.md`, as after an approved Gate 1, and keep the test cases it writes. Do not run the gates.

Trial output: `test-cases.json` (the `test-cases/<story-id>.json` the agent wrote).

Checks: `test_cases_valid`, `automated_case_for_criterion` (`scripts/lib/regression-checks.js`).
