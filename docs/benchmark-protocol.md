# Benchmark Protocol — pipeline vs. raw prompting

> **Status:** IMPROVEMENT-PLAN Phase 5 (PR + run series). This is the
> **pre-registered** protocol for the project's central question
> (`PROJECT-BRIEF.md` §2, weakness #1): _is the ceremony worth it, versus just
> asking an AI directly?_ The tooling (`scripts/benchmark-capture.js`,
> `scripts/selector-survival.js`, `schemas/benchmark-record.schema.json`,
> `evidence/`) ships in the PR; the **measurements** are a human-led run series
> recorded afterward into `evidence/benchmark.jsonl` and written up in
> `docs/evidence.md`.
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

---

## 3. Metrics (definitions + formulas)

Recorded per story × arm in `evidence/benchmark.jsonl`
(`schemas/benchmark-record.schema.json`). An unmeasured metric is `null`, never
`0` — an explicit gap.

| Metric (field)                 | Definition / formula                                                                                                                         | Better |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `time_to_first_green_test_min` | Wall-clock minutes from starting the arm to the first test that runs **green** against the app.                                              | lower  |
| `gate4_corrections`            | B: corrections at Gate 4 before the code was acceptable. A: corrections-to-acceptable judged against the **same** §4 Gate-4 checklist.       | lower  |
| `fictional_test_rate`          | (assertions about behavior **never observed in the running app**) ÷ (all assertions). The rule-8 signal; the pipeline should drive it to ~0. | lower  |
| `selector_survival_rate`       | (locators that still resolve after replay against ≥2 later app versions) ÷ (all locators). `scripts/selector-survival.js`.                   | higher |
| `known_bug_catch_rate`         | (the story's known post-ship bugs this arm's tests would have caught) ÷ (known bugs).                                                        | higher |
| `traceability_coverage`        | (tests carrying a resolvable STORY→RISK→TC→test link) ÷ (all tests). **Expected ~0 for Arm A** — that's a real property, not a defect.       | higher |

**Judging is blind where it can be.** Gate-4 correction counts and the
fictional-test rate for both arms are scored against the same checklist by the
same reviewer, ideally without knowing which arm produced the file.

---

## 4. Procedure (per story)

1. **Arm A:** prompt the model raw, timeboxed. Save its tests. Score the
   metrics. `npm run benchmark:capture -- --story <id> --arm raw ...`.
2. **Arm B:** `npm run pipeline -- --story <id>`; drive the gates
   (`docs/pipeline-runner.md`). Archive with `npm run new-run <id>` (so the
   run **also** counts toward the 10-run `prompt_stability_met` threshold —
   IP-5.7, one effort closing two gaps). Score the metrics.
   `npm run benchmark:capture -- --story <id> --arm pipeline --track <t> ...`.
3. After each pipeline run:
   `npm run session-summary -- --friction "<what rubbed>"`.
4. **Selector survival** (when app history exists): serve ≥2 later app
   versions and run `npm run benchmark:survival -- --tests <file> --version
<url> --version <url>` for each arm. If history is unavailable, record
   `selector_survival_rate: null` and say why in `docs/evidence.md` — **do not
   fake it** (`scripts/selector-survival.js` refuses to).

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
- `npm run metrics` after the series — whether `prompt_stability_met` now
  computes (≥10 logged runs).

---

## 7. Ready-to-run capture commands (per the candidate slate)

Exact `benchmark:capture` command lines for the §2 candidate slate — **two
records per story (raw + pipeline)**. The metric values below are
**placeholders (`0`/`?`-style)**: replace each with what you actually measured
while running the arm. **`--dry-run` first** on each (it validates and prints
without appending), then re-run without `--dry-run` to write the line.

> Flag → metric: `--time-to-green` → time_to_first_green_test_min ·
> `--gate4-corrections` → gate4_corrections (raw arm: read as
> "corrections-to-acceptable" vs the same §4 checklist) · `--fictional-rate` ·
> `--selector-survival` (omit ⇒ `null`; do **not** pass a made-up number) ·
> `--known-bug-catch` · `--traceability` (raw arm is ~0 by construction).
> Always add `--model <id>`, `--operator <you>`, and a `--note`.

```bash
# ── login-success (red: security; standard) ──────────────────────────────
npm run benchmark:capture -- --story login-success --arm raw \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm" --dry-run
npm run benchmark:capture -- --story login-success --arm pipeline --track standard \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm" --dry-run

# ── cart-badge-count-bugfix (red: pricing; standard; a real bugfix) ───────
npm run benchmark:capture -- --story cart-badge-count-bugfix --arm raw \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm" --dry-run
npm run benchmark:capture -- --story cart-badge-count-bugfix --arm pipeline --track standard \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm" --dry-run

# ── sort-products-enhancement (red: pricing; standard) ────────────────────
npm run benchmark:capture -- --story sort-products-enhancement --arm raw \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm" --dry-run
npm run benchmark:capture -- --story sort-products-enhancement --arm pipeline --track standard \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm" --dry-run

# ── checkout-expired-card (red: payment+pricing+business-logic; standard) ─
npm run benchmark:capture -- --story checkout-expired-card --arm raw \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm" --dry-run
npm run benchmark:capture -- --story checkout-expired-card --arm pipeline --track standard \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm" --dry-run

# ── api-create-user (red: security; standard; API branch) ─────────────────
npm run benchmark:capture -- --story api-create-user --arm raw \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm; API/Newman" --dry-run
npm run benchmark:capture -- --story api-create-user --arm pipeline --track standard \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm; API/Newman" --dry-run

# ── YOUR lite story (required ≥1 lite-eligible — supply a real routine one) ─
npm run benchmark:capture -- --story <your-lite-story> --arm raw \
  --time-to-green ? --fictional-rate ? --known-bug-catch ? --traceability 0 \
  --model claude-opus-4-8 --operator you@example.com --note "raw arm; lite-eligible" --dry-run
npm run benchmark:capture -- --story <your-lite-story> --arm pipeline --track lite \
  --time-to-green ? --gate4-corrections ? --fictional-rate ? \
  --known-bug-catch ? --traceability ? \
  --model claude-opus-4-8 --operator you@example.com --note "pipeline arm; lite track" --dry-run
```

Selector survival is **not** a capture flag you guess — produce it with the
replay harness when you have ≥2 app versions, then pass the result:

```bash
# Replay one arm's tests against later app versions to get the rate:
npm run benchmark:survival -- --tests <that-arm's-spec.ts> \
  --version http://localhost:PORT_v2 --version http://localhost:PORT_v3
# …then add --selector-survival <rate> to that story×arm's capture line.
# With <2 versions the harness refuses to invent a number; leave the flag off
# (=> null) and explain in docs/evidence.md.
```

After the series: `npm run metrics` (does `prompt_stability_met` now compute at
≥10 logged runs?), then write `docs/evidence.md` against the §5 thresholds —
**including where raw prompting won.**

---

## 8. References

- `schemas/benchmark-record.schema.json` — the record contract.
- `scripts/benchmark-capture.js` — the validated write path.
- `scripts/selector-survival.js` — the replay harness (honest about gaps).
- `docs/pipeline-runner.md` — how Arm B is driven.
- `docs/review-gates.md` §4 — the Gate-4 checklist both arms are judged by.
- `PROJECT-BRIEF.md` §2, §15 — the question this benchmark exists to answer.
