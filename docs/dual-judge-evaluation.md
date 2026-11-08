# Dual-Judge Framework — Evaluation & Decision

> This document evaluates whether to adopt the
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

## 2. The decision criteria

The rule: **only evaluate after 10+ complete runs**, and adopt only
if **3+ of these criteria** justify it.

| #   | Criterion                                                             | Current finding                                                                                                                                                                                                                          | Justifies adoption? |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Does the current Failure Classifier catch enough cases?               | Yes, so far. The classifier assigns severity on two axes and escalates anything ambiguous to `unknown_needs_human_review` rather than guessing — that escalation IS a semantic-doubt signal, routed to a human at Gate 4.                | **No** (covered)    |
| 2   | Are there false positives (tests that pass but should fail)?          | None observed across the 5 archived runs. The suites are small, business-assertion-focused (web-first Playwright assertions, Newman status+body checks), and human-reviewed at Gate 4 — the exact place a semantic miss would be caught. | **No** (none seen)  |
| 3   | Does YAML-driven testing justify its complexity vs native Playwright? | Not at this scale. The project deliberately uses Playwright Native Agents + Newman (CLAUDE.md §3.9 "reuse before building"); migrating to a YAML test DSL is a large change that competes with, rather than extends, that choice.        | **No**              |
| 4   | Is the team willing to migrate tests to YAML?                         | No signal that it is, and no need expressed. The /evolve loop surfaced PR/workflow friction, not assertion-quality friction.                                                                                                             | **No**              |

**0 of 4 criteria** currently justify adoption (adoption needs 3+).

Additionally, the **precondition was not met** when this was decided:
evaluation requires 10+ complete runs, and the project had **5** archived runs
(`npm run list-runs`). Evaluating the framework's worth on half the required
sample would have been premature on its own terms.

Criterion 2 could only be answered by what people happened to notice. It is
now measured: an escaped defect recorded with `why_missed:
test_passed_wrongly` (`docs/outcome-records.md`) is exactly a test that
passed when it should have failed, and the metrics count them.

---

## 3. Decision

**DEFER.** Do not adopt the dual-judge framework now. Reasons:

1. The precondition (10+ complete runs) is unmet — only 5 exist.
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

The trigger is computed by `npm run metrics` (`dual_judge_trigger` in
`metrics/pipeline-metrics.json`, "Dual-judge re-evaluation trigger" in the
Markdown), and `/evolve` reports it when it fires. Re-open this evaluation
when **either** signal is met:

| Signal                 | Met when                                                                                             | Why it points here                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| False-negative escapes | 3 or more escaped defects with `why_missed: test_passed_wrongly`                                     | A test covered the behavior and passed while the product was wrong: the "technically passed but wrong" case a semantic second judge exists for.                                                                          |
| Missed Gate 2 canaries | 3 or more canaries missed, with the catch rate's 95% upper bound below 90% (`docs/gate-canaries.md`) | A missed canary is a wrong expected result a reviewer approved. A test generated from it asserts the wrong thing and passes or fails for the wrong reason, and the human review meant to catch that is shown to miss it. |

Each signal carries its own minimum count, so a single bad run does not fire
it, and neither needs the run-count precondition: three recorded false
negatives are evidence however many runs there were. The canary bound is the
upper end of the two-sided 95% Wilson interval, so "below 90%" means the
data say, with about 97.5% confidence, that reviewers catch fewer than nine
canaries in ten. While no escaped defect is recorded and no canary was
planted, the trigger is unknown, not "not fired". The trigger is advisory.
Firing re-opens the evaluation; it does not adopt anything.

Still worth re-opening by judgment, though not measured: the project moves to
an app or domain where assertions are inherently semantic (generated content,
ranking quality) and deterministic checks are structurally insufficient.

If re-opened and **3+ criteria** then justify it, adopt the dual-judge **as an
additional reporting/validation layer only** — a second opinion feeding the
Failure Classifier — **never replacing** Playwright/Newman execution or the
`failure-analysis.json` contract. It would be an
adapter behind the existing classification, not a new core.

---

## 5. References

- `agents/failure-classifier.md` — the current two-axis classifier + the
  `unknown_needs_human_review` escalation path.
- `agents/spec-reviewer.md` — the Gate-3 semantic-ish assist already in place.
- `docs/evolve-loop.md` — where the trigger surfaces when it fires.
- `docs/outcome-records.md` — how an escaped defect is recorded.
- `docs/gate-canaries.md` — the Gate 2 canaries and their catch rate.
- `dogkeeper886/test-framework-template` — the upstream dual-judge concept.
