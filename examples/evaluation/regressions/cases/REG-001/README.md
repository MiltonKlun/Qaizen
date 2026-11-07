# REG-001 — Analyst

**Where it comes from (audit-probe).** The Gate 1 check once accepted a criterion whose "more than" had been flipped to "less than" as word for word.

**Expected behavior.** The three criteria are copied word for word, with their comparisons ("more than", "or less") and amounts unchanged.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.
Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim` (`scripts/lib/regression-checks.js`).
