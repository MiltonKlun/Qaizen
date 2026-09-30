# Benchmark Protocol — pipeline vs. raw prompting

> **Status:** tooling shipped; awaiting the run series. This is the
> **pre-registered** protocol for the project's central question
> (`README.md` §"Why it exists"): _is the ceremony worth it, versus just asking an AI
> directly?_ The tooling (`scripts/benchmark-capture.js`,
> `scripts/selector-survival.js`, `schemas/benchmark-record.schema.json`,
> `evidence/`) ships in the PR; the **measurements** are a human-led run series
> recorded afterward into `evidence/benchmark.jsonl` and written up in
> `docs/evidence.md`.
>
> **Protocol version 2.0** (task group 9.2). New records are schema 1.1: each
> carries its provenance (operator, app version, prompt versions, tools,
> runtime, measurement method) and keeps three timings apart (§3). The story
> criteria (§2) and the thresholds (§5) are unchanged. Records captured under
> 1.0 stay as they were recorded; nothing is backfilled.
>
> **Pre-registration matters.** The thresholds in §5 are fixed **before** the
> runs, so the conclusion can't be drawn to fit the result. We commit, up
> front, to what would count as "pipeline worth it" **and** to what would count
> as "raw prompting wins for this class of story". Honest losses are the point.

---

## 1. The two arms

Both arms use the **same model**, the **same stories**, and the **same Gate-4
checklist** to judge output. The only variable is the process.

- **Arm A — raw prompting.** A single model, prompted directly:
  _"Write Playwright tests for this story: <story text>."_ Reasonable
  follow-ups are allowed (the kind a working QA would actually type), but the
  arm is **timeboxed** to keep it comparable — record the box in the writeup.
  No schemas, no gates, no traceability, no required app exploration.
- **Arm B — the pipeline.** The story driven through `npm run pipeline`
  (`docs/pipeline-runner.md`): Analyst → gates → Test Designer → Planner →
  Generator, with the four human gates and the no-tests-from-text-alone rule
  (`CLAUDE.md` §3.8).

One story produces **two records** (one per arm), appended to
`evidence/benchmark.jsonl` via `npm run benchmark:capture`.

---

## 2. Story selection (IP-5.1 — human-supplied)

5–10 **already-shipped** stories with **ground truth** — so "did the tests
catch the real bug?" and "did the locators survive?" are answerable from
history, not opinion. Selection criteria:

- Each story has known post-ship facts: a bug found after release, and/or a
  selector that later broke when the app changed.
- **Mixed sizes** (a one-AC tweak through a multi-flow feature).
- **≥1 red-domain story** (business logic / permissions / security / pricing /
  payment / compliance / data integrity — `docs/healer-guardrails.md` §4).
- **≥1 story suitable for `lite`** (routine, low-risk — exercises Phase 4).

> **Fill this table before the run series begins.** It is the registration of
> what's being measured; do not add or drop stories mid-series without noting
> it in `docs/evidence.md`.

### Proposed candidate slate (confirm / replace before running)

The rows below are a **starting slate drawn from the stories that already exist
in this repo** (`examples/stories/` + their expected-context fixtures), so they
are real and present, not invented. The Red-domain / size columns were computed
by running each story's context through the actual `scripts/track-floor.js`
(`minimumTrack`) — not eyeballed. **Replace any row with one of your own
already-shipped stories where you have better ground truth; this is your
registration, not mine.**

| Story id (fixture)                               | Size (AC/risk)     | Red-domain? (floor)                          | Lite-eligible?       | Ground truth — _you supply_                                         | Why chosen                                                                                                                            |
| ------------------------------------------------ | ------------------ | -------------------------------------------- | -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `login-success` (STORY-001)                      | 3 AC / 2 risk      | **Yes** — security/auth                      | no (floor=standard)  | _e.g. a real post-ship auth bug or a login selector that broke_     | Canonical auth happy+negative path; high-severity session risk                                                                        |
| `cart-badge-count-bugfix` (STORY-003)            | 3 AC / 2 risk      | **Yes** — pricing                            | no                   | _the stale-badge bug this story fixed_                              | A real **bugfix** story — ground truth is the bug itself                                                                              |
| `sort-products-enhancement` (STORY-004)          | 4 AC / 3 risk      | **Yes** — pricing                            | no                   | _e.g. sort-order regression / a `.nth()` selector that later broke_ | A mid-size **enhancement**; good selector-survival candidate                                                                          |
| `checkout-expired-card` (QA-1042)                | 4 AC / 3 risk      | **Yes** — payment + pricing + business-logic | no                   | _expired-card handling bug / declined-payment edge_                 | The strongest **red-domain** case (money) — floor cites 3 domains                                                                     |
| `api-create-user` (API-001)                      | 2 AC / 1 risk      | **Yes** — security                           | no                   | _a validation gap on registration_                                  | API-branch coverage (Newman), not just E2E                                                                                            |
| **`STORY-010` (footer year) or YOUR lite story** | ≤2 AC / 1 low risk | **No**                                       | **YES** (floor=lite) | _trivial cosmetic change_                                           | **Required ≥1 lite-eligible** — the only lite candidate in-repo is the synthetic footer fixture; prefer a real routine story of yours |

> **Honest gap (found while scaffolding this):** every _real_ example story in
> this repo floors to `standard` — they're all SauceDemo commerce/auth stories,
> which legitimately touch pricing/security/payment. The repo has **no genuine
> lite-eligible real story**; the only `lite` candidate is the synthetic
> `STORY-010` footer-year fixture. The protocol requires **≥1 lite-eligible**
> story, so **you must supply at least one real routine story** for the last
> row, or the lite-track arm of the comparison rests on a synthetic fixture
> (acceptable for a first pass, but say so in `docs/evidence.md`).
>
> Also: all five candidates are **SauceDemo-derived**, so they share an app and
> a locator style. For selector-survival (§3) that's fine if you have ≥2 app
> versions; if not, record `selector_survival_rate: null` per story and explain.
>
> **Preferred target for NEW benchmark stories: the local Bench Shop app**
> (`examples/benchmark-app/`, IMPROVEMENT-PLAN-2 Phase 5). Public SauceDemo has
> two ceilings it cannot lift: (1) it is in every model's **training data**, so
> a raw agent can reproduce it from memory (inflating raw's scores — see
> `docs/evidence.md` §5b); and (2) it has **no bugs to catch and one version**,
> so `known_bug_catch_rate` ties 1.0/1.0 and `selector_survival_rate` is
> permanently `null`. Bench Shop fixes both — inject a bug with `--bug`, and
> serve `v1` vs the drifted `v2`. Existing SauceDemo rows stay valid; use Bench
> Shop when a story needs a catchable bug or a real survival number.

---

## 3. Metrics (definitions + formulas)

Recorded per story × arm in `evidence/benchmark.jsonl`
(`schemas/benchmark-record.schema.json`). An unmeasured metric is `null`, never
`0` — an explicit gap.

| Metric (field)                 | Definition / formula                                                                                                                                             | Better |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `time_to_first_green_test_min` | Wall-clock minutes from starting the arm to the first test that runs **green** against the app.                                                                  | lower  |
| `gate4_corrections`            | B: corrections at Gate 4 before the code was acceptable. A: corrections-to-acceptable judged against the **same** §4 Gate-4 checklist.                           | lower  |
| `fictional_test_rate`          | (assertions about behavior **never observed in the running app**) ÷ (all assertions). The rule-8 signal; the pipeline should drive it to ~0.                     | lower  |
| `selector_survival_rate`       | (reviewed probes still finding exactly one usable target on every later version) ÷ (probes valid on the named baseline). `scripts/selector-survival.js --probe`. | higher |
| `known_bug_catch_rate`         | (the story's known post-ship bugs this arm's tests would have caught) ÷ (known bugs).                                                                            | higher |
| `traceability_coverage`        | (tests carrying a resolvable STORY→RISK→TC→test link) ÷ (all tests). **Expected ~0 for Arm A** — that's a real property, not a defect.                           | higher |

**Timing is recorded three ways, kept apart** (schema 1.1 `timing`): the
wall-clock time of the arm, the human attention actually spent reviewing gates
(for the pipeline, the sum of `decided_at − opened_at` over the run's gate
decisions), and the agent/tool execution time only as the tools report it. A
time that was not recorded is `null`; none is estimated, and no provider token
or compute figure is invented. `time_to_first_green_test_min` stays the §5
metric.

**Baseline and later versions** (selector survival, task group 9.1): the
_baseline_ is the named app version an arm's tests were written against, on
which every reviewed probe must resolve its one intended target; a _later
version_ is a subsequent release measured for drift. Earlier text called both
"later versions"; the historic `null` survival results are unchanged by this
wording.

**Judging is blind where it can be.** Gate-4 correction counts and the
fictional-test rate for both arms are scored against the same checklist by the
same reviewer, ideally without knowing which arm produced the file.

---

## 4. Procedure (per story)

1. **Arm A:** prompt the model raw, timeboxed. Save its tests. Score the
   metrics. `npm run benchmark:capture -- --story <id> --arm raw ...`.
2. **Arm B:** `npm run pipeline -- --story <id>`; drive the gates
   (`docs/pipeline-runner.md`). Archive with `npm run new-run <id>` (so the
   run **also** counts toward the 10-run prompt-stability sample of its
   prompt-version cohort (when it records `prompt_versions`) —
   IP-5.7, one effort closing two gaps). Score the metrics.
   `npm run benchmark:capture -- --story <id> --arm pipeline --track <t> ...`.
3. After each pipeline run:
   `npm run session-summary -- --friction "<what rubbed>"`.
4. **Selector survival.** Preferred (local app): serve Bench Shop `v1` and `v2`
   and run `npm run benchmark:survival -- --probe <probe module> --baseline
v1=<v1-url> --version v2=<v2-url>` — see `examples/benchmark-app/README.md`.
   The probes are reviewed code: the exact locators the arm's tests rely on,
   checked against the running app, never rebuilt from text (`--tests <file>`
   only lists a spec's locators for writing them). Against public SauceDemo, do
   this only if you genuinely have ≥2 app versions; otherwise record
   `selector_survival_rate: null` and say why in `docs/evidence.md` — **do not
   fake it** (`scripts/selector-survival.js` refuses to).
5. **Known-bug catch (mutation, local app only).** For a story with a bug the
   Bench Shop can inject, serve with `--bug <id>` and run the arm's tests: the
   bug is **caught iff ≥1 test fails** (green on the clean app, red on the
   mutated one). This replaces the older "would these tests have caught it?"
   judgment with an executable check. See the rubric §3 and
   `examples/benchmark-app/README.md` for the bug ids.

---

## 5. Pre-registered thresholds (fixed before the runs)

Over the selected stories, aggregating per metric:

**"The pipeline is worth it" if ALL hold:**

- `fictional_test_rate`: pipeline median **≤ 0.05** AND raw median **≥ 0.20**
  (the pipeline nearly eliminates invented assertions; raw does not).
- `known_bug_catch_rate`: pipeline median **≥ raw median + 0.20**.
- `selector_survival_rate`: pipeline median **≥ raw median + 0.15** (where
  measurable).
- `traceability_coverage`: pipeline median **≥ 0.90** (raw ~0 by construction).
- `time_to_first_green_test_min`: pipeline median **≤ 3×** raw median — i.e.
  the ceremony's time cost is bounded, not unlimited.

**"Raw prompting wins for this class of story" if EITHER holds:**

- For lite-eligible stories, raw matches the pipeline on
  `known_bug_catch_rate` AND `fictional_test_rate` while being **≥ 2× faster**
  to first green — i.e. for routine work the ceremony doesn't earn its cost
  (this would argue for **widening the lite track**, not abandoning gates).
- The pipeline's `time_to_first_green_test_min` median exceeds **5×** raw with
  no offsetting gain in catch rate or survival — the cost is real and unpaid.

**Mixed result is allowed and expected.** The honest outcome may be "pipeline
wins on important features, raw wins on trivial ones" — which is exactly the
case the lite track (Phase 4) and the when-to-use guide (Phase 7) are built to
exploit. `docs/evidence.md` reports the split, per story class.

---

## 6. Outputs

- `evidence/benchmark.jsonl` — the raw records.
- `docs/evidence.md` — the write-up: results per metric, **where raw prompting
  won**, the measured **median minutes-per-gate** from the Phase-1 telemetry
  (`opened_at`/`decided_at`), and the verdict against §5. Linked from
  `README.md`.
- `npm run metrics` after the series — whether any prompt-version cohort now
  has the 10 eligible runs `prompt_stability` needs for a verdict.

---

## 7. Running the series

The ready-to-run checklist — registration, ground-truth fields, the arm order
recorded in advance, set-up, per-arm commands, capture fields and the
missing-evidence rules — is `docs/benchmark-series-checklist.md`. Every record
captures its provenance (schema 1.1):

```bash
npm run benchmark:capture -- --story <id> --arm <raw|pipeline> [--track <t>] \
  --series <series-id> --operator "<you>" --app <app>@<baseline-version> \
  --model <model-id> --tool <tool>@<version> \
  [--context runs/<story>/<run-id>/context.json]   # pipeline arm: required
  <metric flags> [timing flags] --note "..." --dry-run
```

Selector survival is **not** a capture flag you guess — produce it with the
probe harness when you have a baseline and at least one later app version,
then pass the result:

```bash
# List the locators an arm's spec relies on (source inspection, no rate):
npm run benchmark:survival -- --tests <that-arm's-spec.ts>
# Write them as reviewed probes (see examples/selector-probes/), then measure:
npm run benchmark:survival -- --probe <probes.mjs> \
  --baseline v1=http://localhost:PORT_v1 --version v2=http://localhost:PORT_v2
# …then add --selector-survival <rate> to that story×arm's capture line.
# Without two distinct versions, a working setup, and probes that resolve on
# the baseline, the harness reports no number; leave the flag off (=> null)
# and explain in docs/evidence.md.
```

After the series: `npm run metrics` (does a prompt-version cohort now have 10
eligible runs for a `prompt_stability` verdict?), then write `docs/evidence.md`
against the §5 thresholds — **including where raw prompting won.**

---

## 8. References

- `schemas/benchmark-record.schema.json` — the record contract.
- `scripts/benchmark-capture.js` — the validated write path.
- `docs/benchmark-series-checklist.md` — the ready-to-run series checklist.
- `npm run benchmark:check` — confirms the Bench Shop and its survival probes
  still match the documented drift before a series.
- `scripts/selector-survival.js` — the probe harness (honest about gaps);
  `examples/selector-probes/` and `examples/benchmark-app/` hold reviewed probes.
- `docs/pipeline-runner.md` — how Arm B is driven.
- `docs/review-gates.md` §4 — the Gate-4 checklist both arms are judged by.
- `README.md` §"Why it exists" — the question this benchmark exists to answer.
