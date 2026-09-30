# Benchmark series checklist — pipeline vs. raw prompting

> A ready-to-run checklist for the human-led series that
> `docs/benchmark-protocol.md` pre-registers (protocol version 2.0, task group
> 9.2). The protocol holds the definitions, the story-selection criteria and
> the §5 thresholds; nothing here changes them. **The results tables stay
> blank until actual runs happen.** A value that was not measured is `null`,
> with the reason — never an estimate.

---

## 1. Before the first run — register the series

Fill these in and commit them **before** any arm runs, so the conclusion cannot
be fitted to the result.

- [ ] **Series id:** `series-____-__` (passed as `--series` on every capture).
- [ ] **Operator(s):** who runs the arms.
- [ ] **Model and tools:** the model id and every tool with its version (e.g.
      the coding assistant). The same model for both arms.
- [ ] **Raw-arm timebox:** \_\_\_ minutes, and the exact opening prompt:
      _"Write Playwright tests for this story: <story text>."_
- [ ] **Story slate:** confirm or replace each row of protocol §2 (≥1
      red-domain story, ≥1 lite-eligible story, mixed sizes). Adding or
      dropping a story later is noted in `docs/evidence.md`.
- [ ] **Ground truth per story** (section 2 below), complete before running.
- [ ] **Arm order per story** (section 3 below), recorded in advance.

## 2. Ground truth per story (required fields)

| Story id | App + baseline version | Later version(s) for survival | Known bug(s) and evidence | Track | Ground truth recorded by |
| -------- | ---------------------- | ----------------------------- | ------------------------- | ----- | ------------------------ |
|          |                        |                               |                           |       |                          |

- **App + baseline version:** the app and version the arm's tests are written
  against — for selector survival this is the **baseline**: every probe must
  resolve its one intended target there (`docs/benchmark-protocol.md` §3).
- **Later version(s):** versions after the baseline, measured for drift. On
  the local Bench Shop: baseline `v1`, later `v2` (`examples/benchmark-app/`).
  Public SauceDemo has one version, so survival there is `null` with that
  reason.
- **Known bug(s):** on the Bench Shop, an injectable bug id (`stale-badge` for
  STORY-003, `wrong-item-total` / `inconsistent-total` for STORY-020); for a
  shipped story, the bug and where it is documented. A story with no known bug
  records `known_bug_catch_rate: null`, not a guessed number.

## 3. Arm order, recorded in advance

Alternate which arm runs first so neither arm always benefits from the other's
learning. Fill this before starting and do not change it.

| Story id | First arm | Second arm | Registered on |
| -------- | --------- | ---------- | ------------- |
|          |           |            |               |

A balanced default for the protocol §2 slate, in its order: raw first for the
1st, 3rd and 5th story, pipeline first for the 2nd, 4th and 6th.

## 4. Set up (once per machine)

```bash
npm ci
npx playwright install chromium
npm run benchmark:check     # must print "benchmark:check OK"; fix before measuring
```

`benchmark:check` serves the Bench Shop baseline and its drifted version and
confirms the reviewed survival probes still match the README drift table. If it
fails, the app, the probes or the survival rule changed: stop and fix that
before any measurement.

Bench Shop, when a story runs on it:

```bash
node examples/benchmark-app/serve.js --version v1 --port 4173 [--bug <id>]
node examples/benchmark-app/serve.js --version v2 --port 4174
```

## 5. Per story × arm

**Raw arm.** Start a timer, give the registered prompt, allow only the
follow-ups a working QA would type, stop at the timebox. Save the tests.

**Pipeline arm.** `npm run pipeline -- --story <ref>`; review every gate
yourself (`docs/pipeline-runner.md`). Archive the run (`npm run new-run
<story-id>`); its `runs/<story>/<run-id>/context.json` must record
`prompt_versions`, or the record cannot be attributed and is refused.

**Measure** (definitions in protocol §3):

| Field                          | How                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `time_to_first_green_test_min` | Minutes from starting the arm to the first test green against the app.                                                          |
| `gate4_corrections`            | Corrections before the code met the Gate-4 checklist (same checklist for both arms).                                            |
| `fictional_test_rate`          | Assertions about behavior never observed in the running app ÷ all assertions.                                                   |
| `selector_survival_rate`       | `npm run benchmark:survival -- --probe <reviewed probes> --baseline v1=<url> --version v2=<url>`; null when it reports no rate. |
| `known_bug_catch_rate`         | Serve with `--bug <id>`; the bug is caught iff ≥1 test is green on the clean app and red on the mutated one.                    |
| `traceability_coverage`        | Tests with a resolvable STORY→RISK→TC→test link ÷ all tests (raw ≈ 0 by construction).                                          |
| `timing.wall_clock_min`        | Elapsed minutes, start to finish of the arm.                                                                                    |
| `timing.gate_review_min`       | Pipeline: the sum of `decided_at − opened_at` over the run's `gate_decisions`. Raw: your own review time, if you recorded it.   |
| `timing.agent_tool_min`        | Only what the tools themselves report. Otherwise null.                                                                          |

**Capture** — `--dry-run` first, then again without it to append:

```bash
npm run benchmark:capture -- --story <id> --arm <raw|pipeline> [--track <t>] \
  --series <series-id> --operator "<you>" \
  --app <app>@<baseline-version> [--app-commit <sha>] \
  --model <model-id> --tool <tool>@<version> \
  [--context runs/<story>/<run-id>/context.json]    # pipeline arm: required
  --time-to-green <n> --gate4-corrections <n> --fictional-rate <0..1> \
  [--selector-survival <0..1>] [--known-bug-catch <0..1>] --traceability <0..1> \
  [--wall-clock-min <n>] [--gate-review-min <n>] [--agent-time-min <n>] \
  --note "<what the numbers do not capture>" --dry-run
```

The record is schema 1.1 (`schemas/benchmark-record.schema.json`): the pipeline
arm's prompt versions are read from its context, the runtime from the machine,
and the measurement-method version from the capture script.

## 6. Missing evidence

| If…                                                  | Then                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A metric could not be measured                       | Omit its flag (`null`) and say why in `--note` and in `docs/evidence.md`.                     |
| A timing was not recorded                            | Omit it (`null`). Never reconstruct it from memory or a provider's estimate.                  |
| Selector survival reports no rate                    | `null`, with the harness's reason.                                                            |
| The story has no known bug                           | `known_bug_catch_rate` stays `null`.                                                          |
| The pipeline run records no `prompt_versions`        | The capture is refused; fix the run's context, do not capture without it.                     |
| An arm is re-run, or the registered order is changed | Record it in `docs/evidence.md` with the reason; do not discard the first attempt's evidence. |
| A story is added or dropped                          | Record it in `docs/evidence.md` before evaluating the §5 thresholds.                          |

## 7. Results (fill only from actual runs)

| Story id | Arm | Recorded at | time to green | Gate-4 corr. | fictional | survival | bug catch | traceability | wall clock | gate review | agent/tool |
| -------- | --- | ----------- | ------------- | ------------ | --------- | -------- | --------- | ------------ | ---------- | ----------- | ---------- |
|          |     |             |               |              |           |          |           |              |            |             |            |

## 8. After the series

- [ ] `npm run metrics` — does any prompt-version cohort now have the 10
      eligible runs a stability verdict needs?
- [ ] Write `docs/evidence.md` against the protocol §5 thresholds, per story
      class, **including where raw prompting won**. Corrections to an earlier
      interpretation are added with their evidence, never by rewriting a
      recorded measurement.
