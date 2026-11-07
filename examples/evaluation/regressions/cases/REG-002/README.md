# REG-002 — Analyst

**Where it comes from (audit-probe).** The Gate 1 check once accepted a criterion cut short before its condition ("only when the item total is at least $20.00 and the coupon has not expired").

**Expected behavior.** Both criteria are copied whole, the discount condition included; what the Analyst writes carries the coupon (pricing, a Red domain), so the runner holds the story to the full track, and any track the Analyst proposes is at least standard.

## Running a trial

Run the Analyst (`agents/analyst.md`) on `story.md` as a manual story, as for a real run, and keep the `context.json` it writes. Do not run the gates: the trial is the Analyst's output before Gate 1.

Trial output: `context.json`.

Checks: `context_valid`, `criteria_verbatim`, `track_floor` (`scripts/lib/regression-checks.js`).
