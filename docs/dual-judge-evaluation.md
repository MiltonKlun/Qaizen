# Dual-Judge Framework — Evaluation & Decision

> **Status:** Phase 3 (TG13). This document evaluates whether to adopt the
> dual-judge testing model from `dogkeeper886/test-framework-template` as an
> **additional** layer, and records the decision. **Decision: DEFER** — with an
> explicit re-evaluation trigger. The current Failure Classifier (rule-based +
> agent escalation) plus the Spec Reviewer cover the need at the project's
> current scale.

---

## 1. What the dual-judge model is

`dogkeeper886/test-framework-template` runs each YAML-described test through two
judges:

- **Simple judge** — deterministic. Did the technical assertion pass? (status
  code, value equality, element present).
- **LLM judge** — semantic. _Given the intent of this test, does the result
  actually look right?_ It catches the "technically passed but something is
  off" case a strict assertion misses (e.g. the page returned 200 but rendered
  an empty error state).

The value proposition: a second, semantic opinion reduces false-negatives
(tests that pass when they should fail). The cost: tests must be authored in
the framework's **YAML** form, and every run pays for an extra LLM judgment.

---

## 2. The decision criteria (from the Phase 3 plan, TG13)

The plan says: **only evaluate after 10+ complete Phase-3 runs**, and adopt only
if **3+ of these criteria** justify it.

| #   | Criterion                                                             | Current finding                                                                                                                                                                                                                          | Justifies adoption? |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Does the current Failure Classifier catch enough cases?               | Yes, so far. The classifier assigns severity on two axes and escalates anything ambiguous to `unknown_needs_human_review` rather than guessing — that escalation IS a semantic-doubt signal, routed to a human at Gate 4.                | **No** (covered)    |
| 2   | Are there false positives (tests that pass but should fail)?          | None observed across the 5 archived runs. The suites are small, business-assertion-focused (web-first Playwright assertions, Newman status+body checks), and human-reviewed at Gate 4 — the exact place a semantic miss would be caught. | **No** (none seen)  |
| 3   | Does YAML-driven testing justify its complexity vs native Playwright? | Not at this scale. The project deliberately uses Playwright Native Agents + Newman (CLAUDE.md §3.9 "reuse before building"); migrating to a YAML test DSL is a large change that competes with, rather than extends, that choice.        | **No**              |
| 4   | Is the team willing to migrate tests to YAML?                         | No signal that it is, and no need expressed. The /evolve loop (TG10) surfaced PR/workflow friction, not assertion-quality friction.                                                                                                      | **No**              |

**0 of 4 criteria** currently justify adoption (the plan's bar is 3+).

Additionally, the **precondition is not met**: the plan requires 10+ complete
Phase-3 runs before evaluating; the project has **5** archived runs
(`npm run list-runs`). Evaluating the framework's worth on half the required
sample would be premature on its own terms.

---

## 3. Decision

**DEFER.** Do not adopt the dual-judge framework now. Reasons:

1. The precondition (10+ Phase-3 runs) is unmet — only 5 exist.
2. 0 of 4 adoption criteria are currently satisfied; the bar is 3+.
3. The existing Failure Classifier already encodes the "semantic doubt"
   path: when no rule matches with confidence, it escalates to
   `unknown_needs_human_review` and a human decides — a lighter mechanism that
   reuses the human gate the system already has, instead of a second LLM judge
   on every run.
4. Adopting a YAML test DSL would conflict with the reuse-first principle
   (CLAUDE.md §3.9) and the "Playwright Native Agents, not custom automation"
   constraint (§4).

This is a deferral, **not a rejection**. The idea — a semantic second opinion
on "technically passed" results — is sound; it is simply not yet justified by
evidence or scale, and the system has a cheaper approximation of it today.

---

## 4. Re-evaluation trigger

Re-open this evaluation when **any** of the following becomes true:

- **10+ complete Phase-3 runs** exist (the plan's precondition) AND
- metrics or `/evolve` surface **false negatives** — tests that passed but
  should have failed — as a recurring theme (3+ occurrences), OR
- the Gate-4 reviewer repeatedly catches "technically passed but wrong"
  results by eye (a sign the automated layer is missing semantic checks), OR
- the project moves to an app/domain where assertions are inherently semantic
  (e.g. generated content, ranking quality) and deterministic checks are
  structurally insufficient.

If re-opened and **3+ criteria** then justify it, adopt the dual-judge **as an
additional reporting/validation layer only** — a second opinion feeding the
Failure Classifier — **never replacing** Playwright/Newman execution or the
`failure-analysis.json` contract (Phase 3 §2; TG13 DoD). It would be an
adapter behind the existing classification, not a new core.

---

## 5. References

- `agents/failure-classifier.md` — the current two-axis classifier + the
  `unknown_needs_human_review` escalation path.
- `agents/spec-reviewer.md` — the Gate-3 semantic-ish assist already in place.
- `docs/evolve-loop.md` — where a recurring false-negative theme would surface.
- `docs/deferred.md` — this evaluation layer is deferred, with its trigger.
- `dogkeeper886/test-framework-template` — the upstream dual-judge concept.
