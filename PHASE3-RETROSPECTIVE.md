# Phase 3 — Retrospective

> Written at the end of Phase 3 (controlled healing, metrics, `/evolve`,
> hardening, prompt versioning, multi-feature, enhanced reporting). Input to
> continuous-improvement mode. There is no Phase 4 (`phase3-healing-scaling.md`
> §6). Read alongside `PHASE2-RETROSPECTIVE.md`, which set the priorities this
> phase delivered.

---

## 1. What Phase 3 delivered

Every Phase 3 Task Group landed as its own PR off `main`, each green in CI:

| TG  | Deliverable                                                     | PR  |
| --- | -------------------------------------------------------------- | --- |
| 1   | Rule-based failure pre-classifier (`run-failure-classifier.js`) | #16 |
| 2   | Healer harness with guardrails (`run-healer.js`)               | #18 |
| 3   | Healer CI job (PR-only, informational, never commits)          | #20 |
| 4   | Spec Reviewer agent + deterministic uncovered-risk coverage    | #15 |
| 5   | `runs/` history model (`new-run.js`)                           | #12 |
| 6   | Pipeline metrics (`pipeline-metrics.js`)                       | #19 |
| 7   | Token-efficient context handling (per-agent "loads only")      | #24 |
| 8   | Prompt versioning (agent semver + `prompt_versions` + CI eval) | #21 |
| 9   | Security & data-safety doc + credential-logging audit          | #22 |
| 10  | `/evolve` self-improvement loop + `session-summary`            | #25 |
| 11  | Multi-feature support (`list-runs.js`)                         | #23 |
| 12  | Enhanced release reporting (risk rollup, untested-risk, links) | #26 |
| 13  | Dual-judge evaluation — **DEFER** decision                     | #27 |
| 15  | Code-change awareness via read-only GitHub MCP                 | #14 |

TG14 (this slice + retrospective) closes the phase.

---

## 2. Did the Healer guardrails work as expected?

**Yes — and they are enforced in code, not just documented.** The harness
(`scripts/run-healer.js`, guardrails in `scripts/healer-guardrails.js`) rejects
every forbidden operation: adding `.skip`/`.fixme`, deleting a test, weakening
an assertion (`toBeTruthy`), introducing a snapshot, or changing an expected
value/assertion target.

The TG14 demonstration (`npm run demo:healer`) proves the Green/Red boundary
deterministically, without driving the browser:

- **Green** — a broken-locator fix (only the selector string changes, the
  `toHaveText('Products')` / `toHaveURL` assertions untouched) → **SAFE**, the
  kind of candidate the Healer may emit as a reviewable `.patch`.
- **Red** — a candidate that changes the expected business value
  (`'Products'` → `'Swag Labs'`) to force a failing test to pass → **REJECTED**:
  "changes an expected value/assertion target — forbidden". This is the
  bug-draft path; the Healer never touches it.

The honest scope (stated since TG2): the harness owns the safe, deterministic
guardrail + validation layer; fix *generation* is an explicit agent hook. The
headless harness makes **zero** unsupervised changes, never commits, never
merges. The CI job (TG3) reports rather than patches because CI has no
Gate-4-approved context — it never fabricates one.

> **Why the slice's broken-locator/broken-assertion stories were demonstrated
> via the harness rather than a fresh browser run:** the BEHAVIOR TG14 verifies
> is the guardrail decision (Green allowed, Red rejected), which is proven
> deterministically by `demo:healer`. A full live browser story with a real
> broken locator additionally needs Playwright MCP + the four human gates — the
> same human-in-the-loop path exercised three times in Phase 2 (SK-10/13/16).
> The guardrail is the new Phase-3 capability; it is fully proven here.

## 3. Did the Spec Reviewer add real value?

**Yes, structurally.** It gives Gate 3 a partly-deterministic second read: the
`risk_coverage` / `uncovered_risks` / `uncovered_high_severity_count` are
computed from the `RISK → TC` chain with **no LLM call**, and a high-severity
uncovered risk forces `auto_approval_eligible: false`. It assists; it never
approves — Gate 3 stays human (`CLAUDE.md` §3.5). The contract is proven by the
validated example `spec-review-uncovered.expected-spec-review.json`.

Caveat: the deterministic coverage check is the high-value part. A second-model
semantic-coverage pass was deliberately **not** added — only worth it if
retrospectives later prove the deterministic check misses real gaps (§4.5.a).

## 4. Are the metrics useful?

**Useful, with a known limit.** `npm run metrics` walks `runs/` and reports
pass-rate by story, top failing TCs, flakiest tests, healer validation rate,
product bugs found, and untested high-risk items — verified against the 5
archived runs (SK-16 100%). It handles partial archives gracefully.

The limit (stated in TG6): Gate 3/4 rejection counts are **not recorded
per-run** in the current schema, so the "<10% rejection over 10 runs"
prompt-stability signal can't be computed yet — the script reports it as "not
tracked". Recording per-run gate outcomes is the natural next improvement if the
team wants that signal live.

## 5. Did `/evolve` propose something actionable?

**Yes.** Run against the real 45-commit / 90-day history plus a recorded session
summary, `/evolve` produced two 🔴 high-confidence, evidence-backed findings that
match exactly the real systemic pain of building Phases 2–3:

- **stacked / orphaned PRs** (3 mentions) — accepted, hardened into the
  one-PR-off-main discipline.
- **artifact clobber / single-occupancy** (3 mentions) — accepted, addressed by
  the `runs/` model (TG5).

The loop works as intended: real friction in → scored proposal out → human
decides. It never self-rewrites. The highest-signal source is the human
session-summary; the lesson is to write one after each run.

## 6. Dual-judge decision

**Deferred** (TG13), not rejected. 0 of 4 adoption criteria are currently met
(bar is 3+), and the plan's 10-run precondition is unmet (5 runs). The existing
classifier's `unknown_needs_human_review` escalation already approximates the
"semantic doubt → human" path more cheaply. An explicit re-evaluation trigger is
recorded in `docs/dual-judge-evaluation.md`.

---

## 7. What went well

- **Serialized PR discipline held.** After the three stacking/orphan incidents
  in Phase 2, every Phase 3 TG was one PR off clean `main`, merged before the
  next began. Zero orphans in Phase 3.
- **Architecture Stability Rule held under real schema changes.** TG8
  (`prompt_versions`) and TG12 (enhanced report) each moved schema + agents +
  docs + examples (+ migration) in one PR; the `contract-stability` CI check
  passed both.
- **The "deterministic part in code, judgment part as an agent hook" pattern**
  recurred cleanly across the classifier, the healer, and `/evolve` — each
  ships a safe, testable core and an explicit human/agent boundary.
- **CI jobs that self-validate on their own PR.** The new `healer` and
  `prompt-eval` jobs each ran and behaved correctly on the very PR that
  introduced them.

## 8. What was friction / honest gaps

- **Commit-message quoting in PowerShell↔bash.** Two commits initially failed
  because a here-string with quotes was run in the wrong shell; the fix was to
  pass messages via `-F <file>`. Cheap once learned; worth a note in any future
  contributor guide.
- **Per-run gate-rejection metrics not captured** (see §4) — the one metric the
  plan wanted that the schema doesn't yet support.
- **Several Phase-3 capabilities are agent/human-loop by design** (Spec Reviewer
  semantic read, live Healer patch generation, the four gates). They are proven
  by contracts/examples/harness here, not by an unattended end-to-end run —
  which is the correct posture for a human-in-the-loop system, but means "the
  pipeline ran fully autonomously" is *not* a claim Phase 3 makes, by design.

---

## 9. Phase 3 completion checklist

- [x] `run-failure-classifier.js` exists; outputs validate.
- [x] `run-healer.js` creates reviewable patches only; guardrails enforced in
      code (unit-verified + TG14 Green/Red demo).
- [x] Healer CI job processes Green only, never commits.
- [x] Yellow/Red always require human action.
- [x] Spec Reviewer assists Gate 3 without replacing the human.
- [x] `runs/` model exists; `new-run.js` works; `list-runs.js` views it.
- [x] `pipeline-metrics.js` produces metrics after completed runs.
- [x] Context handling token-efficient (per-agent "loads only").
- [x] Dual-judge evaluated (DEFER documented).
- [x] Security/data-safety docs exist; credential audit clean.
- [x] Agent prompts versioned; `prompt_versions` pins runs.
- [x] Reporting enhanced for release decisions.
- [x] `/evolve` ran on real data and proposed actionable improvements.
- [x] `PHASE3-RETROSPECTIVE.md` exists (this file).

---

## 10. Entering continuous-improvement mode

Phase 3 is the last planned phase. From here (`phase3-healing-scaling.md` §6):

- Every 90 days or every 10 runs: run `/evolve`.
- Every 5 runs: run pipeline metrics.
- Every major prompt change: run the evaluation dataset (`prompt-eval` enforces
  this on PRs that touch `agents/`).
- Every quarter: review docs vs reality; fix drift.

**Highest-value next improvements** (from this retro, not new phases):
record per-run Gate 3/4 outcomes so the prompt-stability metric goes live;
keep writing a session-summary after each run so `/evolve` stays sharp;
re-open the dual-judge question if false-negatives ever recur at 10+ runs.

Rejected by design, permanently: full agentic batch processing without gates
(it contradicts the founding human-in-the-loop principle at Gate 4).
