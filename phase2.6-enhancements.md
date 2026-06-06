# Phase 2.6 — Enhancements (post-TG13)

> **Status:** planned, approved 2026-06-04 after Phase 2 closed (TG13 + retro
> merged). These are **additions, not redesigns** — same discipline as
> `IMPROVEMENTS.md`: if any item starts to need a new orchestration layer, a
> new infra dependency, or more than a handful of fields + one MCP, stop and
> reconsider. Each item ships as its own small branch → PR → green CI → merge.
>
> Two sources fed this plan: the user's own TG14 idea (Jira write-back), and
> the externally-researched `IMPROVEMENTS.md` (three vetted enhancements). The
> Phase-3 items live in `phase3-healing-scaling.md`.

This project is **generic and reusable** (portfolio-grade, to be published).
Prefer pluggable/configurable designs over anything hardcoded to one
workspace — the same Open/Closed philosophy as the `TestManagementAdapter`
port (`agents/test-management-adapter.md`).

---

## Order of work (approved)

1. **TG2.6-1 — Reporter uncovered-risk reporting** (Improvement 3, partial)
2. **TG2.6-2 — Jira export helper** (TG14 Option A)
3. **TG2.6-3 — Jira as a pluggable test-case destination** (TG14 Option B)
4. **TG2.6-4 — Shift-left `design_stage`** (Improvement 2)

Phase-3 items (runs/ layout, GitHub-diff awareness, Spec-Reviewer coverage)
are tracked in `phase3-healing-scaling.md`.

---

## TG2.6-1 — Reporter uncovered-risk reporting (Improvement 3, partial)

Make zero-coverage risks an explicit, deterministic output of the release
report (not something a human must notice). The Reporter already computes
`coverage_by_risk`; this adds the explicit gap fields. The full version
(inside the Phase 3 Spec Reviewer, feeding Gate 3) is in
`phase3-healing-scaling.md`.

**Schema change** (`schemas/release-report.schema.json`) — Architecture
Stability Rule applies (schema + `agents/reporter.md` + docs + examples +
`validate:examples` in one PR). Add:

```
uncovered_risks (array of strings)            risk_ids with zero covering TCs
uncovered_high_severity_count (number)        count of those that are high severity
```

Derived deterministically from `coverage_by_risk` + `context.json.risks`
severities — no LLM call.

**Definition of Done**

- [ ] `schemas/release-report.schema.json` has the two new fields; existing
      examples still validate (add/extend an example).
- [ ] `agents/reporter.md` computes them from the traceability it already
      walks; documents that `pass` is not appropriate while a high-severity
      risk is uncovered.
- [ ] `docs/review-gates.md` / `docs/traceability.md` note the explicit
      uncovered-risk surfacing.
- [ ] Architecture Stability Rule satisfied in one PR.

---

## TG2.6-2 — Jira export helper (TG14 Option A)

A script that turns local artifacts (test cases, risks) into Jira-ready
output (ADF / wiki markup, or a CSV for Jira's bulk importer). The human
pastes/imports — **zero write-risk to the shared board**. Reuses the
`create-jira-bugs.js` parser shape.

**Definition of Done**

- [ ] `scripts/export-to-jira.js` (or similar) emits paste/CSV-ready output
      from `test-cases/<id>.json` (and optionally context risks).
- [ ] Dry-run by default; writes a file or stdout, never touches Jira.
- [ ] Documented in `docs/` with a short how-to.

---

## TG2.6-3 — Jira as a pluggable test-case destination (TG14 Option B)

> **Reframed per the generic-reusability goal:** not "auto-create in Jira" as
> a one-off, but a **pluggable destination behind the existing
> `TestManagementAdapter` port** so a reuser who lives in Jira (no TestLink)
> is served. Same Open/Closed design as TestLink (and the planned Xray/Qase).

Add a Jira test-case adapter selectable by config:

- `TEST_MANAGEMENT_TOOL=testlink` → sync to TestLink (today).
- `TEST_MANAGEMENT_TOOL=jira` → create test-case issues in Jira.
- `both` / `none` → both or neither.

Local `test-cases/*.json` stays the **single system of record**; TestLink and
Jira are both downstream mirrors chosen by config. Gate it exactly like
`create-jira-bugs.js`: dry-run default, `--apply`, duplicate-safe via a
written-back key, field mapping in `config/jira-testcase-map.json`, and a
`--limit` guard. Issue type configurable (e.g. "Test"/"Task").

**Definition of Done**

- [ ] `scripts/create-jira-testcases.js` (the Jira adapter) — dry-run default,
      `--apply`, dedup via written-back Jira key, `config/jira-testcase-map.json`.
- [ ] Destination selectable via `TEST_MANAGEMENT_TOOL`; TestLink path
      unchanged; `none` writes nothing.
- [ ] `agents/test-management-adapter.md` documents Jira as an implemented
      adapter alongside TestLink.
- [ ] Local JSON remains the system of record; Jira/TestLink are mirrors.

---

## TG2.6-4 — Shift-left `design_stage` (Improvement 2)

Allow the design-half (Analyst → Gate 1 → Test Designer → Gate 2) to run at
**refinement** time, not only at ready-for-QA, so draft test scenarios act as
shared acceptance criteria during development.

> **Honest scoping note for THIS pipeline:** our orchestration is
> human-driven (no automatic Jira-status triggers exist), so this is a
> **documented two-entry-point convention + one optional field**, not an
> automated trigger. That is the right size — we are not adding trigger infra.

**Schema change** (`schemas/test-cases.schema.json`) — Architecture Stability
Rule applies. Add an optional field parallel to `status`:

```
design_stage (enum, optional): "pre_development" | "ready_for_qa"
```

- `pre_development`: produced during refinement; revisited when code exists.
- `ready_for_qa`: validated against the implementation.

At ready-for-QA, the Test Designer **refines** existing `pre_development`
cases (and may apply GitHub-diff context once that lands) and flips them to
`ready_for_qa` — it does **not** regenerate from scratch.

**Definition of Done**

- [ ] `schemas/test-cases.schema.json` has optional `design_stage`; existing
      examples still validate.
- [ ] `docs/pipeline-architecture.md` + `docs/review-gates.md` document the
      two-entry-point model and which gates apply when (G1/G2 at both; G3/G4
      only at ready-for-QA — no code to test during refinement).
- [ ] Single-entry-point workflow (ready-for-QA only) still works unchanged.
- [ ] No new agent, no trigger automation, no state machine.

---

## Not adopted (recorded so it stays decided)

- The reference system's AWS Lambda / Cloud Run orchestrator, ECR
  integration, and custom Jira Sink — already covered by MCPs + the existing
  pipeline; adopting custom infra reverses the deliberate no-infra decision
  (same reasoning that ruled out n8n, `README.md` §1.4).
- A default second-LLM coverage cross-check — the deterministic traceability
  query is reliable and free; only revisit if retrospectives prove a
  _semantic_ coverage gap, and even then as an addition, not a replacement.
