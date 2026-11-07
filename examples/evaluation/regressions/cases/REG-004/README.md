# REG-004 — Analyst

**Where it comes from (audit-probe).** The Gate 1 check once accepted a Jira comment promoted to an acceptance criterion.

**Expected behavior.** The one criterion is recorded; the HTML comment and the product owner's comment are context, not criteria.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.

Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim` (`scripts/lib/regression-checks.js`).
