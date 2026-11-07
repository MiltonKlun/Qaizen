# REG-003 — Analyst

**Where it comes from (audit-probe).** The Gate 1 check once accepted an "Out of scope" line promoted to an acceptance criterion.

**Expected behavior.** Only the two in-scope criteria are recorded; the out-of-scope price order is not a criterion.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.
Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim` (`scripts/lib/regression-checks.js`).
