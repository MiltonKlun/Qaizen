# Benchmark scoring rubric

> **Status:** companion to `docs/benchmark-protocol.md`. The protocol §3 defines
> _what_ each metric means; this rubric defines _exactly how to score it_ so the
> number is a repeatable procedure, not a judgment call. Both arms (raw +
> pipeline) are scored by the **same** rubric, ideally without knowing which arm
> produced the file. Written before the first real scoring (the pilot) so the
> numbers can't be drawn to fit a result.
>
> **Rule of honesty:** if a metric cannot be scored by the procedure below with
> the evidence actually available, it is `null` (an explicit gap), never a
> softened guess. `null` is always acceptable; an unverifiable number is not.

---

## How to read this rubric

Each metric has: **Inputs** (what you look at), **Procedure** (the exact steps),
and **Verifiable by** (how a third party re-checks the number). A score is only
valid if someone else, following the Procedure on the same Inputs, lands on the
same value.

---

## 1. `traceability_coverage` (0..1, higher better)

- **Inputs:** the arm's test file(s).
- **Procedure:** count `T` = total `test(...)` blocks; count `L` = blocks that
  carry a resolvable STORY→RISK→TC→test link (an id like `TC-001` / `RISK-001`
  in a comment or metadata that resolves to a real entry in this run's
  `context.json` / `test-cases`). Score = `L / T`.
- **Raw arm:** ~0 by construction (no chain exists). Record the computed value.
- **Verifiable by:** grep the file for `TC-`/`RISK-` and confirm each resolves.
  Objective.

## 2. `fictional_test_rate` (0..1, lower better)

The protocol's definition is literal: _assertions about behavior **never
observed in the running app** ÷ all assertions_. The grounding question per
assertion is: **"when this test was written, had its expected value been
confirmed against the running app?"**

- **Inputs:** the arm's test file + the record of what the author observed while
  writing (for the pipeline arm: the Planner's exploration / spec notes; for the
  raw arm: nothing — it did not open the app).
- **Procedure:** count `A` = total assertions (`expect(...)` calls). Count `F` =
  assertions whose expected value was **not** grounded in an observation made
  while authoring. Score = `F / A`.
  - **Raw arm rule:** the raw arm performs zero app exploration by definition, so
    every assertion is ungrounded at authoring time ⇒ `F = A` ⇒ rate ≈ **1.0**.
    (That tests later happen to pass does **not** retro-ground them — passing is
    measured separately by `known_bug_catch_rate` and the green run. This is the
    property the benchmark exists to expose: raw asserts before it observes.)
  - **Pipeline arm rule:** an assertion is grounded if its expected value traces
    to something the Planner actually observed (in the spec/exploration). An
    assertion the generator invented beyond what was observed counts toward `F`.
- **Verifiable by:** list every `expect(...)`; for each, point to the observation
  that grounded it (or note "none"). The list is the evidence.

## 3. `known_bug_catch_rate` (0..1, higher better)

Scored against the story's **documented** ground-truth bug(s). For a logic
check (no source access to mutate), use the **would-it-fail test**: _read the
test against the bug's behavior; if the buggy behavior would make this test
FAIL, the test catches the bug._

- **Inputs:** the story's documented bug (e.g. STORY-003 "Background"); the
  arm's test file.
- **Procedure:** enumerate `B` = the story's distinct documented bug behaviors.
  For each, find whether **any** assertion would fail under the buggy behavior.
  Score = `(bugs with ≥1 catching assertion) / B`.
  - A test only "catches" a bug if, **on the buggy app**, that test would go red.
    An assertion that would still pass on the buggy app does NOT catch it — even
    if it looks related.
- **Verifiable by:** for each documented bug, name the asserting line that would
  fail, or state "none". A reviewer re-reads those lines against the bug text.
  (If true mutation testing is available — controllable source — prefer it and
  say so.)

## 4. `gate4_corrections` (count, lower better)

- **Inputs:** the arm's test file + the Gate-4 checklist (`docs/review-gates.md`
  §4 — locator stability, assertions test real business behavior, no
  skipped/weakened tests, no unjustified hard waits, readable, approved scope
  covered).
- **Procedure:** a reviewer reads the file against the checklist and lists each
  **distinct** defect that would require a change before acceptance. Score =
  number of distinct defects. One defect = one correction (don't double-count
  the same issue across lines).
  - **Pipeline arm:** if the run was actually driven through Gate 4, use the
    real recorded count of rejection→rework cycles instead.
- **Verifiable by:** the enumerated defect list, each tied to a checklist item
  and a line. A second reviewer can agree/disagree per item.

## 5. `time_to_first_green_test_min` (minutes, lower better)

- **Procedure:** wall-clock minutes from starting the arm to the first test that
  runs green against the app. Record the **measured** value and the
  **operator** (human vs AI). An AI-operated time is not human-representative —
  record it, but flag it in the note and in `docs/evidence.md`.
- **Verifiable by:** the start/first-green timestamps. Objective, but read with
  the operator caveat.

## 6. `selector_survival_rate` (0..1, higher better)

- **Procedure:** only via `scripts/selector-survival.js` replaying the arm's
  tests against **≥2 later app versions**. With fewer than 2 versions the
  harness refuses to produce a number ⇒ record `null` and state why.
- **Verifiable by:** the replay command + its output, or the documented reason
  it is `null`.

---

## Scoring discipline

- **Score blind where possible.** Ideally the scorer does not know which arm
  produced the file (strip the path/comments that reveal it).
- **Evidence travels with the number.** Every non-objective score (2, 3, 4) is
  recorded with its evidence list in `docs/evidence.md`, so the number is
  auditable, not asserted.
- **`null` over guess.** Always.
