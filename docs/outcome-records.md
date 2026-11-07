# Outcome records — escaped defects and run cost

The archived runs say what a run did. Some outcomes are only known later, or
only to the people who ran it: a bug the run should have caught turns up in
staging, or the run took an afternoon of someone's time. These are recorded
after the fact, by a person, under `outcomes/`, and read by `npm run metrics`
and `npm run defect-history`.

| Record          | File                                    | Schema                               |
| --------------- | --------------------------------------- | ------------------------------------ |
| Escaped defect  | `outcomes/escaped-defects/ESC-NNN.json` | `schemas/escaped-defect.schema.json` |
| Cost of a story | `outcomes/costs/<story>.json`           | `schemas/story-cost.schema.json`     |

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
- a `--risk` is not a risk of that run, or a `--case` not one of its cases;
- no risk is named and no `--unresolved "<why>"` says why none covers it
  (`CLAUDE.md` §3.4: an unresolved link is stated, never faked);
- the date is in the future, or the record does not validate.

**Why it was missed** is the field the metrics turn on:

| `why_missed`          | Meaning                                                             | Cases named |
| --------------------- | ------------------------------------------------------------------- | ----------- |
| `no_case`             | No approved case covered the behavior: a scope gap (Gates 1–2).     | none        |
| `not_automated`       | A case covered it, decided manual, component or skip.               | at least 1  |
| `test_passed_wrongly` | An automated test covered it and passed: a false negative.          | at least 1  |
| `not_run`             | The covering test did not run.                                      | at least 1  |
| `unknown`             | Not known yet. Record it now and replace the file once it is known. | any         |

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

## 3. What the metrics make of them

`npm run metrics` adds, beside the counts it already had:

- **Gate time**: minutes from brief to decision, per gate and per run. It
  includes any pause, so it is an upper bound on review effort.
- **Rounds to approval**: decisions per approval, per gate, and the share
  approved the first time, with its 95% interval.
- **Flake rate**: repeat checks that found a flaky test, and flaky tests per
  check, earlier checks of a run included (`repeat_check.earlier`).
- **Heals per test**: validated heals per healed test, and the tests healed
  more than once.
- **Escaped defects**: by why they were missed and by severity.
- **Cost and time per story**: totals and per-run averages of what was
  entered, per currency.
- **Dual-judge trigger**: whether escaped false negatives or missed Gate 2
  canaries re-open the evaluation (`docs/dual-judge-evaluation.md` §4).

None recorded is reported as unknown, never as zero: a defect is only known
to have escaped once someone records it.
