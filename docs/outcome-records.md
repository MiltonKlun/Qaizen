# Outcome records — escaped defects, run cost and outside reviews

The archived runs say what a run did. Some outcomes are only known later, or
only to the people who ran it: a bug the run should have caught turns up in
staging, the run took an afternoon of someone's time, or an outside
reviewer looked again at an approval the sampled outside review marked. These are recorded
after the fact, by a person, under `outcomes/`, and read by `npm run metrics`
and `npm run defect-history`.

| Record          | File                                    | Schema                               |
| --------------- | --------------------------------------- | ------------------------------------ |
| Escaped defect  | `outcomes/escaped-defects/ESC-NNN.json` | `schemas/escaped-defect.schema.json` |
| Cost of a story | `outcomes/costs/<story>.json`           | `schemas/story-cost.schema.json`     |
| Outside review  | `outcomes/outside-reviews/<story>.json` | `schemas/outside-review.schema.json` |

Only `scripts/record-outcome.js` writes here, run by a person; no agent does
(`docs/artifact-boundaries.md` §2). It names an archived run under `runs/`
and never changes it: an archive is evidence. `outcomes/` is not a run
folder, so starting a new story neither archives nor clears it. Nothing here
approves anything, and nothing is sent to Jira.

---

## 1. Escaped defects

An escaped defect is a product bug that a **completed** run should have
caught and did not. Record it against that run:

```bash
npm run record-outcome -- escaped-defect --story STORY-010 \
  --run 2026-06-28T12-00-00Z-cartbadge --risk RISK-001 --case TC-001 \
  --summary "The badge kept the old count after a remove on a second tab." \
  --severity high --found-in staging --found-at 2026-07-03 \
  --why-missed test_passed_wrongly --by "QA lead"
```

`--run` is the archive folder under `runs/<story>/` or the run id its
context records. The script refuses, with nothing written, when:

- the run is not archived, is a demo, or is not completed;
- a `--risk` is not a risk of that run;
- a `--case` is not an approved case of that run, or its automation
  decision does not fit why the defect was missed (the table below);
- `test_passed_wrongly` names a case the run's execution ledger records as
  anything but passed;
- no risk is named and no `--unresolved "<why>"` says why none covers it
  (`CLAUDE.md` §3.4: an unresolved link is stated, never faked);
- the same defect is already recorded: the same Jira key, or the same run
  and summary. `--replace ESC-NNN` rewrites that record under its id;
  `--force-new` records another defect that only looks the same;
- the date is after today, or the record does not validate.

**Why it was missed** is the field the metrics turn on:

| `why_missed`          | Meaning                                                         | Cases named                    |
| --------------------- | --------------------------------------------------------------- | ------------------------------ |
| `no_case`             | No approved case covered the behavior: a scope gap (Gates 1–2). | none                           |
| `not_automated`       | An approved case covered it, decided manual or skip.            | 1+, manual or skip             |
| `test_passed_wrongly` | An automated test covered it and passed: a false negative.      | 1+, automated (e2e, API, comp) |
| `not_run`             | The covering automated test did not run.                        | 1+, automated (e2e, API, comp) |
| `unknown`             | Not known yet. Record it now; `--replace` it once it is known.  | any                            |

A component case counts as automated: its suite runs outside the pipeline,
but a component test that passed while the product was wrong is a false
negative all the same.

Escaped defects feed the defect history the Analyst reads for a risk's
likelihood: they are past product bugs, cited by story and ESC id, and they
also say the run's tests missed that area. Each one is also a candidate case
for the agent regression set (`docs/prompt-versioning.md` §3a).

## 2. Cost and time per story

The pipeline measures gate time (from each decision's brief to its
decision), but not the hands-on time a person spent on a run, nor what the
run spent on models or services. The operator enters both, per run:

```bash
npm run record-outcome -- cost --story STORY-010 \
  --run 2026-06-28T12-00-00Z-cartbadge --minutes 95 \
  --spend 3.40 --currency USD --by "QA lead"
```

At least one of `--minutes` and `--spend` is given; `--currency` is an
ISO 4217 code. A run already entered is refused unless `--replace` is
passed. Entries for a run the metrics do not count (a demo, a removed
archive) are left out and counted apart.

## 3. Outside reviews

On the `full` track, a solo approval at Gate 2 or Gate 4 can rest on the
sampled outside review, when the team set a rate for it
(`docs/review-gates.md`, "Independence at Gates 2 and 4"). The decisions
the draw marks are reviewed after the fact by someone outside the team,
who records their verdict once the run is archived:

```bash
npm run record-outcome -- outside-review --story STORY-001 \
  --run 2026-06-06T13-00-00Z-independence --gate gate4 \
  --verdict disagree --by "Dana (partner QA)" \
  --notes "TC-003 asserts the error banner but never that no session was created."
```

`--gate` is `gate2`, `gate4` or `gate4-api` (or its key). The verdict is on
the latest marked approval at that gate unless `--decided-at` names
another, by the `decided_at` its run records. The script refuses, with
nothing written, when:

- the run is not archived or is a demo;
- no approval at that gate in the run is marked for outside review;
- `--by` is the person who made the decision, or the operator noted for the
  inputs it approved: an outside review is someone else's;
- a `disagree` gives no `--notes` saying what is wrong;
- that decision already has a verdict, unless `--replace` is passed by
  the outside reviewer who recorded it: nobody else can replace a verdict.

A selection holds for the rest of the run at its gate, so an approval made
again there is marked too. The verdict owed is on the latest marked
approval at each gate; an earlier one a later approval replaced is counted
apart, not as waiting. A run archived twice is counted once, from its first
archive in name order, so a verdict recorded against the other copy is
reported as naming no marked decision.

A verdict changes nothing in the run. A disagreement is for the team to
follow up: reopen the gate in a new run of the story, or record the
problem as an escaped defect once it is found.

## 4. What the metrics make of them

`npm run metrics` adds, beside the counts it already had:

- **Gate time**: minutes from brief to decision, per gate and per run. It
  includes any pause, so it is an upper bound on review effort.
- **Rounds to approval**: decisions per approval, per gate, and the share
  approved the first time, with its 95% interval. A re-approval after a
  change to the reviewed inputs returned the gate to pending is counted
  apart, so it does not inflate the first-time share.
- **Flake rate**: repeat checks that found a flaky test, and flaky tests per
  check, earlier checks of a run included (`repeat_check.earlier`; past the
  twenty a record keeps, the rest are counted as not kept).
- **Heals per test**: validated heals per healed test, and the tests healed
  more than once.
- **Escaped defects**: by why they were missed and by severity, over the
  runs the metrics count (a record of any other run is counted apart).
- **Cost and time per story**: totals and per-run averages of what was
  entered, per currency.
- **Outside reviews**: the decisions marked for outside review, how many
  were reviewed and agreed with, each disagreement, and each one still
  waiting; a verdict for a run the metrics do not count is counted apart.
- **Dual-judge trigger**: whether escaped false negatives or missed Gate 2
  canaries re-open the evaluation (`docs/dual-judge-evaluation.md` §4);
  unknown while nothing is recorded and no canary was planted.

None recorded is reported as unknown, never as zero: a defect is only known
to have escaped once someone records it.
