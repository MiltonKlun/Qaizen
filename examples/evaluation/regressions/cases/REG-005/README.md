# REG-005 — Analyst

**Where it comes from (audit-probe).** The Red-domain floor once missed every Spanish term, so a payment story written in Spanish could run below the full track.

**Expected behavior.** Both criteria are copied word for word in Spanish, and the story is held to the full track because it takes a payment.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.
Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim`, `track_at_least` (`scripts/lib/regression-checks.js`).
