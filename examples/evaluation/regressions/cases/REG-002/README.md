# REG-002 — Analyst

**Where it comes from (audit-probe).** The Gate 1 check once accepted a criterion cut short before its condition ("only when the item total is at least $20.00 and the coupon has not expired").

**Expected behavior.** Both criteria are copied whole, the discount condition included, and the story is held to the full track (a coupon is pricing, a Red domain).

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.
Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim`, `track_at_least` (`scripts/lib/regression-checks.js`).
