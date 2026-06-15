# When to use this pipeline (and when to just prompt an AI)

> **Status:** IMPROVEMENT-PLAN Phase 7 (PFI-6). An honest fit guide. The whole
> point of the project is to be worth its ceremony — which means being equally
> clear about **when it isn't**. Misapplying it (forcing a throwaway script
> through four gates) is how a useful tool becomes resented. This page tells
> you, and your coworkers, when to reach for it and when to skip it.
>
> The empirical backing for these calls is `docs/evidence.md` (the
> pipeline-vs-raw-prompting benchmark). Until that run series is done, the
> guidance below is **reasoned, not yet measured** — it follows from what the
> pipeline structurally does, and it will gain teeth (or get corrected) once
> the numbers land. It says so honestly where that matters.

---

## TL;DR

| Your situation                                                   | Reach for                                     | Why                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Important feature; bugs would hurt                               | **Full pipeline** (`npm run pipeline`)        | Four gates + traceability + tests written against the running app       |
| Red-domain work (money, permissions, security, data, compliance) | **Full pipeline — and the floor enforces it** | `scripts/track-floor.js` refuses `lite` here; these get the full review |
| Routine, low-risk change (copy tweak, cosmetic UI)               | **Lite track** (`track: lite`)                | Same validation + traceability, less prose (`docs/review-gates.md`)     |
| You need an audit trail / to hand work to a coworker             | **Full or lite pipeline**                     | The traceability chain + gate decisions are the deliverable             |
| One-off throwaway script, a spike you'll delete                  | **Just prompt an AI directly**                | The ceremony earns nothing here; see "what you forfeit" below           |
| You only want one capability, not the whole flow                 | **An à-la-carte piece**                       | See the standalone one-pagers (`docs/standalone-*.md`)                  |

---

## Strong fits

Use the pipeline when **the cost of a wrong or brittle test is real**:

- **Multi-AC features.** More than a couple of acceptance criteria, real
  branching, or cross-page flows — the kind of thing where "the AI wrote
  something plausible" isn't good enough and you want the risk→case→spec→test
  chain checked at each step.
- **Red-domain stories.** Anything touching business-logic calculations,
  permissions/roles, security, pricing, payment, compliance, or data integrity
  (`docs/healer-guardrails.md` §4). The lite floor **will not let these be
  lite** — by design. These are exactly where a fictional or weakened test is
  most dangerous.
- **Anything needing an audit trail.** Regulated work, a release you must
  justify, or work you're handing to a coworker who wasn't in the room. The
  traceability chain and the recorded gate decisions (`gate_decisions[]` with
  `opened_at`/`decided_at`) are the artifact that survives you.
- **A team standard / greenfield suite.** When you're setting the norm for how
  tests get written, the discipline is the value.

## Poor fits — and what to do instead

Be honest; don't force these through the machinery:

- **One-off scripts and throwaway spikes.** If you'll delete it next week, the
  gates and schemas cost more than they return. **Prompt the AI directly.**
- **Sub-lite work.** Below even the lite track's bar — a one-line fix you'll
  eyeball in ten seconds. The lite track exists for routine work; _sub-lite_ is
  "routine and trivial." Prompting directly is the right call. **What you
  forfeit, explicitly:** traceability (no risk→case→test chain), the audit
  trail (no recorded gate decisions), and the no-tests-from-text-alone
  guarantee (nobody confirmed the AI's test against the running app). If none
  of those matter for this change, you don't need the pipeline — and that's a
  legitimate answer, not a failure.
- **Foreign stacks.** The execution spine assumes Playwright + Newman. If
  you're on Cypress/k6/something else, the pipeline's _generation + execution_
  don't fit yet (a `TestRunnerAdapter` is deferred — `docs/deferred.md`). You
  can still **borrow the ideas** (the Automation Decision Model, the
  Green/Yellow/Red rule, the four-gate checklist) — see the à-la-carte docs.
- **Expecting autonomy.** If what you actually want is "an agent that writes
  and merges tests while I'm away," this is the wrong tool **on purpose**.
  Gate 4 is permanently human; the runner refuses non-TTY gate approval. The
  pipeline makes a human _faster_, not _absent_.

## "Which track for this story?"

1. Touches a Red domain, or any high-severity risk, or many ACs/risks?
   → **standard** (the floor forces it; `npm run pipeline` will refuse `lite`).
2. Genuinely routine and low-risk (cosmetic, copy, a small isolated tweak)?
   → **lite** — propose `track: "lite"`; you still classify every case and keep
   traceability, just with less narrative.
3. Highest-risk feature you want maximum ceremony on? → **full**.
4. So trivial that even lite is overhead? → **don't use the pipeline**; prompt
   directly, knowing what you forfeit (above).

The floor is **conservative**: a false "this looks red" only ever _adds_
ceremony, never removes it. When in doubt it errs toward standard — which is
the safe direction.

## The honest cost

The pipeline is not free. It costs setup, per-story orchestration (even with
the thin runner), and reviewer minutes at each gate. The whole reason
`docs/evidence.md` and the gate-cost telemetry exist is to put a real number on
that cost so this trade-off is made on data, not vibes. Read that page before
you argue either side.

---

## References

- `docs/pipeline-runner.md` — how to run the full/lite flow.
- `docs/review-gates.md` — the four gates and the lite consolidation.
- `docs/healer-guardrails.md` §4 — the Red taxonomy the lite floor enforces.
- `docs/evidence.md` — the measured pipeline-vs-raw comparison (the data behind
  this guide).
- `docs/standalone-*.md` — adopt one piece without the whole pipeline.
- `docs/deferred.md` — what's intentionally not built yet (e.g. non-Playwright
  runners) and the triggers to revisit.
