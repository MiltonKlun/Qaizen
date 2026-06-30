# Evidence — pipeline vs. raw prompting

> **Status:** PILOT RESULT (n = 1). One story has been run through both arms to
> validate the measurement loop; the protocol's aggregate verdict still awaits
> the full series (`docs/benchmark-protocol.md`). The project reports only what
> it has actually measured, and labels this honestly as a single data point —
> it does not over-claim from n = 1 (`STRATEGY.md`).

This is the project's answer to its own central question: **why use this
ceremony instead of asking an AI directly?** It reports measured results —
**including where raw prompting won** — against the thresholds pre-registered
in `docs/benchmark-protocol.md` §5.

---

> **Status: PILOT (n = 1).** One story (`cart-badge-count-bugfix`, STORY-003)
> through both arms — a single data point to **prove the measurement loop**, not
> to draw the verdict. The thresholds in `docs/benchmark-protocol.md` §5 are
> aggregate calls and are **not** evaluated here; they need the full 5–10 story
> series. Read this as "the method works and here is what one story showed,"
> not "the question is answered."

## 1. Verdict

**Mixed — and exactly the split the project predicts (n = 1, directional).**
For this red-domain bugfix story, **raw prompting was far faster to a green
test, but the pipeline produced a test you could actually trust**: zero
fictional assertions, full traceability, no review defects, and a test that
genuinely pins the regression. Raw got to green quickly _and_ caught the bug —
but with a fully ungrounded assertion set, no traceability, and three Gate-4
defects, including a scenario (its AC3) that would have **missed** the
regression because it navigated first (the reload self-corrects the bug). The
pipeline cost more wall-clock but only **~4 minutes of human gate attention**;
the rest was agent compute and (in this conversational run) human latency
between turns — see §4 and the §5 caveat.

This is one story, so it is a worked example of the trade, not proof. It does
not trigger any §5 threshold (those are aggregates over the series).

---

## 2. Results by metric

One story × two arms (`evidence/benchmark.jsonl`). With n = 1, "median" = the
single value. Thresholds shown for reference only — **not evaluated at n = 1.**

| Metric                       | Raw  | Pipeline | Threshold (§5)        | Evaluated?                      |
| ---------------------------- | ---- | -------- | --------------------- | ------------------------------- |
| time_to_first_green_test_min | 1\*  | 52†      | pipeline ≤ 3× raw     | no (n=1; both figures caveated) |
| gate4_corrections            | 3    | 0        | (reported, not gated) | —                               |
| fictional_test_rate          | 1.00 | 0.00     | pl ≤ .05 ∧ raw ≥ .20  | dir. consistent                 |
| selector_survival_rate       | null | null     | pl ≥ raw + .15        | not measured (1 app version)    |
| known_bug_catch_rate         | 1.00 | 1.00     | pl ≥ raw + .20        | dir. **not** met (tie)          |
| traceability_coverage        | 0.00 | 1.00     | pipeline ≥ .90        | dir. consistent                 |

\* **Raw time is theoretical / under-counted.** It was an AI operator writing in
one shot — no human reading the story, typing, or iterating. A real raw session
would be longer (≈5–15 min). † **Pipeline time is a real wall-clock but mixes
three things:** agent compute (~11 min: Planner + Generator + Healer), human
gate review (~4 min, from telemetry — see §4), and **conversational latency**
between turns (the rest), which is an artifact of running this across a chat,
not a property of the pipeline. The trustworthy timing figure is the **gate
cost in §4**, which is immune to both distortions. **Lesson for the series:**
`time_to_first_green` is the least reliable metric in a conversational run;
favor wall-clock from a single uninterrupted session, and lean on §4 telemetry.

---

## 3. Where raw prompting won

- **Speed to first green:** raw reached a passing test in ~1 min vs the
  pipeline's ~15 min of active work (and 52 min of conversational wall-clock).
  Even discounting the AI-operator distortion, raw is clearly faster to a first
  result — as expected.
- **Bug catch (tie, not a loss but worth naming):** raw's `known_bug_catch_rate`
  matched the pipeline (1.00) for this story — its AC1-equivalent happened to
  assert the count in-place. So on _catch rate alone_, the ceremony did not beat
  raw here. **But** raw earned that 1.00 alongside a 1.00 fictional rate and a
  scenario that would have missed the bug — i.e. it was right by luck of a
  familiar app, not by verification. The implication is **not** "skip the
  pipeline"; it is that on a well-known app raw can get lucky, which is exactly
  why the lite track + `docs/when-to-use.md` exist (use raw for trivial work,
  the pipeline when a wrong/brittle test is costly).

---

## 4. Gate cost (from telemetry)

Real `opened_at` → `decided_at` per gate, this run (STORY-003, standard track):

| Gate                  | Minutes  |
| --------------------- | -------- |
| Gate 1 — Requirements | 0.7      |
| Gate 2 — Test scope   | 1.1      |
| Gate 3 — Specs        | 0.3      |
| Gate 4 — Code         | 2.0      |
| **Total**             | **~4.1** |

**The four gates cost ~4 minutes of human attention for this story.** This is
the figure the whole telemetry chain was built to produce — and unlike
`time_to_first_green`, it is unaffected by agent compute or conversational
latency. (n = 1; it will become a median over the series.)

---

## 5. Method & limitations

- Stories, arms, thresholds: `docs/benchmark-protocol.md` (pre-registered).
  Scoring procedure: `docs/benchmark-scoring-rubric.md` (written before scoring;
  both arms scored by the same rules, with evidence).
- Raw data: `evidence/benchmark.jsonl` (one record per story × arm).
- **n = 1.** This is a pilot to validate the loop. No §5 aggregate threshold is
  evaluated. Outcomes are labeled "directionally consistent / not met / not
  measured," never "passed."
- **Timing is the weakest metric here** (see §2 footnotes): raw under-counted
  (AI, one-shot), pipeline inflated by conversational latency. The §4 gate-cost
  telemetry is the reliable timing figure.
- **Selector survival = null:** only one SauceDemo version available; the replay
  harness refuses to invent a number (`scripts/selector-survival.js`).
- **Operator was an AI**, not a working QA; both arms share that, but it limits
  external validity. A human-operated series is the next step.
- **The pipeline's generated test was not flawless:** the Generator emitted an
  ambiguous `getByText` locator that passed its own verification but failed in
  the full-suite run; the Healer fixed it within guardrails (no expected value
  changed). Honest: the pipeline isn't immune to locator bugs — but the failure
  classified cleanly as Green/test-bug and never touched a product assertion.

---

## 6. Next steps

- Add the remaining slate stories (protocol §2) to move from n = 1 to a real
  series; re-evaluate §5 thresholds once ≥5 stories are in.
- Run at least one arm **human-operated** (and time it in a single uninterrupted
  session) to remove the AI-operator and conversational-latency distortions.
- Supply a real lite-eligible story so the "raw wins for routine work" threshold
  can be tested (every current candidate floors to standard).

## 7. References

- `docs/benchmark-protocol.md` — the pre-registered protocol.
- `docs/benchmark-scoring-rubric.md` — how each metric is scored (with evidence).
- `evidence/benchmark.jsonl` — the raw records (2 so far: STORY-003 raw + pipeline).
- `evidence/README.md` — the raw-data folder.
- `npm run metrics` — the prompt-stability threshold this series also feeds.
