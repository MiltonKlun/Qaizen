# Deferred ledger — decisions with triggers, not forgotten items

> Some scope was deliberately **not built**.
> This is the difference between "deferred" and "forgotten": each entry has an
> explicit **re-evaluation trigger**. Review this list on the existing
> `/evolve` cadence (every 90 days or 10 runs, `docs/evolve-loop.md`); when a
> trigger fires, re-open the item.

| Item                                | What it is                                                                                                                             | Deferred until (trigger)                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Story-source + CI ports**         | Generalize the front door (story source) and CI the way test-management was generalized (a port + adapters).                           | `docs/evidence.md` is published **and** a second story source or CI provider is actually needed by an adopter.                                                        |
| **`TestRunnerAdapter`**             | Make execution pluggable (Cypress / k6 / manual-only) so non-Playwright teams get the pipeline's value. The biggest architectural gap. | `docs/evidence.md` is published **and** a concrete non-Playwright adopter exists.                                                                                     |
| **Compound-Engineering vocabulary** | Map Compound-Engineering terms to this project's primitives.                                                                           | The runner + lite track are adopted by **≥2 coworkers** (i.e. the team is large enough for shared vocabulary to matter).                                              |
| **Ideate/brainstorm front-end**     | A pre-Analyst "is this worth testing / what should we test first" step (own skills, not a plugin).                                     | ≥2 coworkers using the flow, and a felt need for front-of-loop prioritization.                                                                                        |
| **Compound-Engineering plugin**     | Decide whether to install `everyinc/compound-engineering-plugin`.                                                                      | A coworker already uses it, **or** the front-of-loop skills prove insufficient. **Never** adopting its autonomy endpoint — that contradicts the permanent human gate. |
| **Dual-judge evaluation**           | A second-judge layer over agent evaluation (`docs/dual-judge-evaluation.md`).                                                          | Prompt-eval drift or a measured judging-reliability problem the single evaluator can't catch.                                                                         |

## How to re-open an item

1. The trigger fired — note where (a run, a coworker request, an evidence result).
2. If still worth doing, take it on as its own change (one PR off `main`, the
   usual discipline) — do not just start coding it.
3. If the trigger fired but it's _still_ not worth it, record that decision
   here (update the row) so the next reviewer doesn't re-litigate it.

## Why these are deferrals, not rejections

None of these is forbidden (unlike n8n / dashboards / autonomous batch, which
are permanent no's — `README.md` §9, `STRATEGY.md`). They are **good ideas
without a current trigger**. Building them now would be speculative scope; the
trigger is what turns them from speculation into justified work.
