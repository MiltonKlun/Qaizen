# REG-005 — Analyst

**Where it comes from (audit-probe).** The Red-domain floor once missed every Spanish term. It reads what the Analyst writes as well as the story, so the Analyst must carry a Spanish payment story into its context word for word, where the runner finds the payment domain.

**Expected behavior.** Both criteria are copied word for word in Spanish; what the Analyst writes carries the payment, so the runner holds the story to the full track, and any track the Analyst proposes is at least standard.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.

Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim`, `track_floor` (`scripts/lib/regression-checks.js`).
