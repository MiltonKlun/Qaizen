# Evidence — pipeline vs. raw prompting

> **Status:** EARLY RESULTS (2 stories). STORY-003 ran through both arms
> (the pilot, §1–§5); STORY-020 ran through the full pipeline arm solo, and its
> "raw" attempt surfaced a notable finding (§5b). The protocol's aggregate
> verdict still awaits the full series (`docs/benchmark-protocol.md`). The
> project reports only what it has actually measured and does not over-claim
> from a handful of data points (`STRATEGY.md`).

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

## 5a. Second story — STORY-020 (checkout order summary), pipeline arm

The second story ran through the **full pipeline solo**, driven entirely by the
human in one uninterrupted terminal session (no conversational latency — the
timing lesson from §5 applied). Real Playwright Native Agents throughout
(Planner + Generator); **no Healer needed — all 5 tests passed on first
execution.**

| Metric (pipeline arm)        | Value | Note                                                                             |
| ---------------------------- | ----- | -------------------------------------------------------------------------------- |
| time_to_first_green_test_min | 12    | Solo, single session — a clean measurement (cf. STORY-003's latency-inflated 52) |
| gate4_corrections            | 0     | Approved first pass; no post-Gate-4 failure either                               |
| fictional_test_rate          | 0.00  | Money-math read live; **zero hard-coded price constants** (verified by grep)     |
| known_bug_catch_rate         | 1.00  | TC-002/TC-003 fail if item-total ≠ sum or total ≠ subtotal+tax                   |
| traceability_coverage        | 1.00  | Spec + TC-/RISK- ids on every test                                               |
| selector_survival_rate       | null  | one app version                                                                  |

**Gate cost (real telemetry):** G1 0.2 · G2 0.1 · G3 0.1 · G4 0.1 = **~0.5 min
total.** The solo run's gate cost is an order of magnitude below STORY-003's ~4
min — most of that earlier figure was conversational latency, not review, which
this run confirms. Recorded as the `pipeline` record for `checkout-order-summary`
in `evidence/benchmark.jsonl`.

The money-math is the headline: TC-002 and TC-003 read the rendered
prices/tax/total and assert relationships (`total === subtotal + tax`) in integer
cents. A wrong item total or an inconsistent total fails the run; a
SauceDemo price or tax-rate change does not (the test verifies the app's
arithmetic, not a memorized number).

## 5b. An "accidental third arm" — explored-but-ungated (STORY-020 raw attempt)

The intended **raw** arm for STORY-020 did not stay raw. Given access to the
Playwright MCP, the agent **refused to write a text-only test** — it explicitly
invoked the no-fictional-tests rule, drove the live app (login → checkout →
overview → finish), read the real prices/tax/total, and only then wrote the
spec. The result: 5 tests, all passing live, with the money-math done
**correctly** (live-read, integer-cents, no magic numbers) — verified
independently (grep confirms no hard-coded money in any assertion).

This is **not** the protocol's raw arm (§1: "no required app exploration"). It is
a third, unplanned condition: **pipeline-minus-gates** — full app grounding, but
no gates, no traceability, no schema. Scored by `docs/benchmark-scoring-rubric.md`:

| Metric                | Value | vs. pipeline   | vs. a true raw arm     |
| --------------------- | ----- | -------------- | ---------------------- |
| fictional_test_rate   | 0.00  | same           | far better (raw ≈ 1.0) |
| known_bug_catch_rate  | 1.00  | same           | same/luckier           |
| traceability_coverage | 0.00  | worse (pl 1.0) | same                   |
| gate4_corrections     | ~1    | worse (pl 0)   | better                 |
| time_to_first_green   | null  | (not timed)    | —                      |

_(The ~1 gate-4 note: it used CSS-class locators (`.title`, `.summary_\*`) rather
than the more robust `data-test` attributes the pipeline's Generator chose.)\_

**The finding — and it is the interesting one:** a capable agent given app access
**will not** produce a fictional test; it self-grounds. So the pipeline's
"no fictional tests" value is **strongest against a text-only agent** (like the
STORY-003 raw arm, `fictional_rate 1.0`) and **weakest against an agent that
already explores** — where the pipeline's remaining, still-real advantages are
**traceability, gates, and the audit trail**, not fictionality per se. This
argues for reading "why the pipeline" as _governance and traceability_ first,
_grounding_ second — because a good agent may ground itself, but it will not
gate, trace, or record itself.

**Recorded here in prose only, not in `benchmark.jsonl`:** the record schema's
`arm` enum is `raw | pipeline`; a third value is a schema change under the
Architecture Stability Rule, deferred until a text-only raw arm proves the
distinction is worth encoding. A **true text-only raw arm for STORY-020 is still
owed** (run it with no app access) to complete the intended comparison.

---

## 6. Next steps

- **Run a true text-only raw arm for STORY-020** (no app/MCP access) to complete
  the comparison the §5b attempt did not — see that section.
- Add the remaining slate stories (protocol §2) to move toward a real series;
  re-evaluate §5 thresholds once ≥5 stories are in. (Solo single-session runs,
  per §5a, give the cleanest timing.)
- A lite-eligible story now exists (`examples/stories/footer-social-links.md`,
  STORY-021, verified to floor to `lite`) — run it to exercise the lite track
  and test the "raw wins for routine work" threshold.
- Consider whether §5b's finding warrants encoding a third `arm` value
  (schema change) once a text-only raw arm confirms the distinction is stable.

## 7. References

- `docs/benchmark-protocol.md` — the pre-registered protocol.
- `docs/benchmark-scoring-rubric.md` — how each metric is scored (with evidence).
- `evidence/benchmark.jsonl` — the raw records (2 so far: STORY-003 raw + pipeline).
- `evidence/README.md` — the raw-data folder.
- `npm run metrics` — the prompt-stability threshold this series also feeds.
