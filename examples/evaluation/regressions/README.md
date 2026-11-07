# Agent regression set

> **Owner:** Human / team. The cases a prompt or model change is scored on
> (`docs/prompt-versioning.md` §3a). The set is the bar the agents must keep
> clearing; a case is added for every false heal or escaped defect.

Each case is an input, the agent it is for, the behavior expected of the
agent, and the checks that decide it (`manifest.json`,
`schemas/regression-set.schema.json`). The manifest also holds the number of
trials k and the decision rule, so both are written and committed before any
run.

| Case    | Agent         | Source         | What it guards                                                  |
| ------- | ------------- | -------------- | --------------------------------------------------------------- |
| REG-001 | Analyst       | audit probe    | A comparison ("more than", "or less") copied unchanged          |
| REG-002 | Analyst       | audit probe    | A criterion copied whole, its condition included; full track    |
| REG-003 | Analyst       | audit probe    | An "Out of scope" line is not a criterion                       |
| REG-004 | Analyst       | audit probe    | A comment (HTML or a "Comments" section) is not a criterion     |
| REG-005 | Analyst       | audit probe    | A Spanish payment story copied verbatim and held to full        |
| REG-006 | Test Designer | Bench Shop bug | `stale-badge` is covered by an automated case                   |
| REG-007 | Test Designer | Bench Shop bug | `wrong-item-total` and `inconsistent-total` are covered         |
| REG-008 | Healer        | false heal     | Declines to "heal" a wrong price by changing the price          |
| REG-009 | Healer        | false heal     | Declines to "heal" a stale badge by changing the count          |
| REG-010 | Healer        | control        | Still repairs a genuine v2 test-id rename, within the guardrails |

No escaped defect has been recorded on the current product yet, so no case
comes from one. Each one that is found becomes a case here, with the input
that produced it and the behavior that would have caught it.

## Running an evaluation

The evaluator never runs an agent. For every case of the agent whose prompt
(or model) is changing, run the agent k times on the case's input, as its
`cases/REG-XXX/README.md` says, and put each output in its own folder:

```
<trials-dir>/
  REG-001/trial-1/context.json
  REG-001/trial-2/context.json
  REG-001/trial-3/context.json
  REG-008/trial-1/candidate.spec.ts   # absent when the Healer declined
  ...
```

Then, with the model declared as for a run:

```powershell
$env:QAIZEN_MODEL = '<model id>'
node scripts/evaluate-agents.js --regressions <trials-dir> --agent analyst
```

Each trial passes when every check of its case passes. The report gives per
case the trials passed out of k, pass^k (every trial passed) and a Wilson 95%
interval on its pass rate; then the share of cases passing every trial, and of
trials passing, each with its interval; and the decision. A missing trial is
missing work (exit 2), never a smaller denominator.

The results go to `evidence/regressions/<agent>.json` (or `all.json` without
`--agent`) and are committed with the change. What is already there is the
previous result the rule compares with. A re-run that measures the same thing
(same outputs, prompts, model, set) leaves the file as it is.

## The decision rule

Written in `manifest.json` before the run. Today: block the change when any
case fails all 3 of its trials, or when the share of cases passing every trial
falls below the lower bound of the previous results' interval. The evaluator
refuses to run while this folder has uncommitted changes, so the rule and the
cases that judged a change are in history before the results they produced.

A block is the documented "needs rework" outcome, not a gate: the human reads
the failed trials and decides. Small sets detect only large regressions (a
case dropping from 3 of 3 to 0 of 3 is borderline significant on its own), so
a failing case is re-run to separate a flake from a regression, and more cases
are worth more than more trials.

## What the checks cannot see

The checks are mechanical (`scripts/lib/regression-checks.js`): criteria
compared with the story as Gate 1 compares them, the declared track, links to
real risks and criteria, an automated case for a named criterion, whether the
Healer changed the test and whether the guardrails accept the change. Whether
a risk is the right risk, or a case tests the right thing, is still read
against the gate rubrics (`docs/review-gates.md`).
