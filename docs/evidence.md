# Evidence — pipeline vs. raw prompting

> **Status:** SKELETON — awaiting the run series. The protocol and tooling
> shipped in IMPROVEMENT-PLAN Phase 5; this document is filled in once a human
> has run the two arms over the selected stories
> (`docs/benchmark-protocol.md`). Until then the verdict below is **"not yet
> measured"**, by design — the project refuses to assert value it hasn't
> demonstrated (`PROJECT-BRIEF.md` §2, weakness #1).

This is the project's answer to its own central question: **why use this
ceremony instead of asking an AI directly?** It reports measured results —
**including where raw prompting won** — against the thresholds pre-registered
in `docs/benchmark-protocol.md` §5.

---

## 1. Verdict

> _Not yet measured._ Fill after the run series. State plainly which of the
> three outcomes held: (a) pipeline worth it, (b) raw prompting wins for this
> class of story, (c) mixed — and for which story classes each.

---

## 2. Results by metric

> Populate from `evidence/benchmark.jsonl` after the series. Medians across the
> selected stories, pipeline vs. raw, with the per-metric threshold from §5 of
> the protocol and a pass/fail against it.

| Metric                       | Raw (median) | Pipeline (median) | Threshold (§5)        | Met? |
| ---------------------------- | ------------ | ----------------- | --------------------- | ---- |
| time_to_first_green_test_min | _TBD_        | _TBD_             | pipeline ≤ 3× raw     |      |
| gate4_corrections            | _TBD_        | _TBD_             | (reported, not gated) |      |
| fictional_test_rate          | _TBD_        | _TBD_             | pl ≤ .05 ∧ raw ≥ .20  |      |
| selector_survival_rate       | _TBD_        | _TBD_             | pl ≥ raw + .15        |      |
| known_bug_catch_rate         | _TBD_        | _TBD_             | pl ≥ raw + .20        |      |
| traceability_coverage        | _TBD_        | _TBD_             | pipeline ≥ .90        |      |

---

## 3. Where raw prompting won

> **Required section — not optional.** Name the stories/metrics where raw
> prompting matched or beat the pipeline, and what that implies (e.g. "for
> lite-eligible stories raw was 2× faster with equal catch rate → widen the
> lite track / point people at the when-to-use guide", not "ignore it").

---

## 4. Gate cost (from Phase-1 telemetry)

> The adoption argument made concrete. From the `opened_at`/`decided_at`
> timestamps recorded on gate decisions (IMPROVEMENT-PLAN Phase 1), report the
> **median minutes per gate** observed across the pipeline-arm runs:
>
> | Gate              | Median minutes |
> | ----------------- | -------------- |
> | Gate 1 / qa_scope | _TBD_          |
> | Gate 2            | _TBD_          |
> | Gate 3            | _TBD_          |
> | Gate 4            | _TBD_          |
>
> "The four gates cost a median of X minutes per story" — the sentence this
> whole telemetry chain was built to let us say truthfully.

---

## 5. Method & limitations

- Stories, arms, and thresholds: `docs/benchmark-protocol.md` (pre-registered).
- Raw data: `evidence/benchmark.jsonl` (one record per story × arm).
- **Selector survival** is environment-dependent: if ≥2 later app versions
  were unavailable, the rate is `null` here and the reason is stated — never
  fabricated (`scripts/selector-survival.js` enforces this).
- Sample size is small (5–10 stories); this is **directional evidence**, not a
  statistical proof. Re-run as more stories accrue.

---

## 6. References

- `docs/benchmark-protocol.md` — the pre-registered protocol.
- `evidence/README.md` — the raw-data folder.
- `npm run metrics` — the prompt-stability threshold this series also feeds.
