# Pipeline Architecture

> **Status:** Phase 1 complete; Phase 1.5 (API branch) in progress. The
> E2E branch and the dual E2E/API flow (§4–5) are active. Sections marked
> **Deferred to Phase X** are intentionally not built yet. Do not implement
> them while in an earlier phase — see the per-phase plan files.

This document is the architectural reference for the AI-assisted QA pipeline.
For binding rules, see `CLAUDE.md` (operating instructions) and the per-phase
plan files (`phase1-foundation-e2e.md`, `phase1.5-api-branch.md`,
`phase2-integrations.md`, `phase3-healing-scaling.md`). For the system-level
overview and decisions, see the project `README.md`.

---

## 1. Purpose

The pipeline takes a single user story (from Jira via MCP read-only, or a
manual `story.md`) and produces, with **four human gates**, a complete and
traceable QA package:

- A validated `context.json` describing the story, ACs, risks, and review
  status.
- A test-case file with an **Automation Decision** per case (E2E / API /
  component / manual / skip).
- A Playwright Markdown spec (from the Playwright Planner Native Agent) and
  generated Playwright tests (from the Playwright Generator Native Agent).
- _(Phase 1.5+)_ A Postman collection plus a Newman environment for the API
  branch.
- A classified failure analysis with per-failure severity (Green/Yellow/Red)
  per the Healer guardrails.
- A release report and, for every Red failure, a bug draft.
- _(Phase 2+)_ Bugs promoted to Jira issues with explicit human approval, and
  test cases / execution results synced to TestLink.

It is built on three deliberate choices documented in the project `README.md`
section 1:

1. **Reuse mature pieces.** Playwright Native Agents, official MCPs
   (Atlassian / Playwright Test / Postman / TestLink), and skills adapted
   from `dogkeeper886/ai-qa-workflow` instead of building equivalents from
   scratch.
2. **Wrap them in a strict discipline layer.** JSON Schemas + AJV, the
   Architecture Stability Rule, traceability IDs, folder ownership, and a
   list of forbidden work per phase.
3. **Keep humans in the loop.** Four review gates, with **Gate 4 permanently
   human**, and Healer guardrails that never permit a direct commit to main.

---

## 2. Phase scope at a glance

| Phase   | Adds                                                          | Document                    |
| ------- | ------------------------------------------------------------- | --------------------------- |
| **1**   | Foundation + vertical E2E slice with MCP Atlassian read-only. | `phase1-foundation-e2e.md`  |
| **1.5** | Rama API: Postman MCP, Newman, API Agent, schema extensions.  | `phase1.5-api-branch.md`    |
| **2**   | Writes (Jira bugs, TestLink sync) + GitHub Actions CI.        | `phase2-integrations.md`    |
| **3**   | Controlled Healer, Spec Reviewer, runs/, metrics, /evolve.    | `phase3-healing-scaling.md` |

Each phase has a Forbidden Work list and explicit completion criteria. The
next phase does not start until the previous phase's retrospective is
written and reviewed.

---

## 3. Layered view

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 0 — Discipline                                                      │
│ JSON Schemas + AJV · Folder ownership · Traceability IDs                 │
│ Architecture Stability Rule · Forbidden work per phase                   │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 1 — Skills lifecycle (adapted from ai-qa-workflow)                  │
│ skills/receiving-tickets · skills/planning-tests                         │
│ skills/designing-cases · skills/analyzing-logs                           │
│ skills/syncing-testlink (Phase 2)                                        │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 2 — Custom agents (only where no reuse exists)                      │
│ agents/analyst · agents/test-designer                                    │
│ agents/failure-classifier · agents/reporter                              │
│ agents/api-agent (Phase 1.5) · agents/spec-reviewer (Phase 3)            │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 3 — Official MCPs (never re-written)                                │
│ atlassian (read-only in P1; writes in P2)                                │
│ playwright-test (Native Agents)                                          │
│ postman (Phase 1.5) · testlink (Phase 2)                                 │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 4 — Four human gates (never skipped)                                │
│ G1 Requirements · G2 Test Scope · G3 Specs · G4 Code (PERMANENT HUMAN)   │
└─────────────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────────┐ ┌─────────────────────────────────────┐
│ E2E branch                   │ │ API branch (Phase 1.5+)              │
│ Playwright Native Agents     │ │ Postman MCP + Newman                 │
│ (planner / generator /       │ │ Collections + environments           │
│ healer)                      │ │ Failure classifier (extended)        │
│ playwright-test MCP          │ │                                      │
└──────────────────────────────┘ └─────────────────────────────────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 5 — Execution + reporting                                           │
│ Failure Classifier (rule-based first, LLM only on ambiguous in Phase 3)  │
│ Healer guardrails Green/Yellow/Red (enforced in code in Phase 3)         │
│ Bug drafts → Jira with explicit human approval (Phase 2+)                │
│ TestLink result sync (Phase 2+)                                          │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA 6 — Continuous improvement (Phase 3+)                               │
│ Retrospective per phase · /evolve every 90 days · pipeline metrics       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Phase 1 vertical slice (end-to-end)

This is what runs today. The flow is **manual orchestration**: a human
moves the work from one stage to the next, with the gates in between.

```
story.md (manual) ─or─ Jira issue (mcp-atlassian read-only)
        │
        ▼
  Analyst Agent (uses skills/receiving-tickets)
        │
        ▼
  context.json (validates against schemas/context.schema.json)
        │
        ▼
  ── GATE 1 — Requirement Interpretation (human) ──
        │
        ▼
  Test Designer Agent (uses skills/planning-tests + skills/designing-cases)
        │
        ├──► planner-input/[story-id].planner-brief.md
        └──► test-cases/[story-id].json
              (validates against schemas/test-cases.schema.json)
        │
        ▼
  ── GATE 2 — Test Scope Approval (human) ──
        │
        ▼
  Playwright Planner Native Agent (drives the app via playwright-test MCP,
                                   anchored on tests/seed.spec.ts +
                                   the planner brief)
        │
        ▼
  specs/[story-id].md
        │
        ▼
  ── GATE 3 — Specs Review (human) ──
        │
        ▼
  Playwright Generator Native Agent
        │
        ▼
  tests/[story-id].spec.ts
        │
        ▼
  ── GATE 4 — Code Review (human, PERMANENTLY HUMAN) ──
        │
        ▼
  npm run test  → reports/results.json + traces + screenshots
        │
        ▼
  Failure Classifier Agent (uses skills/analyzing-logs)
        │
        ├──► analysis/failure-analysis.json
        └──► release/bug-drafts/BUG-XXX.md (for Red failures)
        │
        ▼
  Reporter Agent
        │
        ├──► release/release-report.md
        └──► release/release-report.json
              (validates against schemas/release-report.schema.json)
        │
        ▼
  PHASE1-RETROSPECTIVE.md
```

Phase 1 ends when one story has produced this full chain and the
retrospective is written.

### 4.1 Two entry points (Phase 2.6, shift-left)

The chain above splits into a **design half** (Analyst → Gate 1 → Test
Designer → Gate 2 — no code needed) and an **execution half** (Planner →
Gate 3 → Generator → Gate 4 → execute → report — needs code). The design
half may be run at **refinement** (before code exists) to produce draft
test cases as a shared acceptance contract, or at **ready-for-QA** (the
default). Cases designed at refinement carry `design_stage:
"pre_development"` and are **refined, not regenerated**, at ready-for-QA.
Gates 3/4 apply only at the execution half. This is a documented
convention + one optional schema field — not trigger automation (this
pipeline's orchestration is human-driven). See `docs/review-gates.md`
("Two entry points") and `phase2.6-enhancements.md` TG2.6-4.

---

## 5. API branch — Phase 1.5+

The API branch runs **in parallel** with the E2E branch. When the Test
Designer marks a case `automate_api`, that case feeds the API Agent
(`agents/api-agent.md`) instead of the Playwright Planner. Both branches
share the same upstream (Analyst → Gate 1 → Test Designer → Gate 2) and
the same downstream (Failure Classifier → Reporter); they diverge only in
the middle (authoring + execution).

For Phase 1.5 the API under test is **reqres.in** (`https://reqres.in/api`),
because Saucedemo — the E2E target — has no real backend API. See
`docs/ambiguities.md` A3.

### The dual flow (extends the Phase 1 vertical slice)

The Phase 1 vertical slice (`phase1-foundation-e2e.md` TG13) becomes a
dual flow. Steps 1–7 and 14–21 are shared; steps 8–13 fork per branch.

```
Steps 1–7  (shared)  Analyst → Gate 1 → Test Designer → Gate 2
                      Produces context.json + test-cases/[story-id].json
                      + planner-input/[story-id].planner-brief.md

Step 7.5   (shared)  Branch classifier — simple logic, NOT a new agent.
                      Read test-cases/[story-id].json. Count automate_e2e
                      vs automate_api. If automate_api > 0, run the API
                      branch in parallel with the E2E branch.

┌─ E2E branch (steps 8–13) ────────┐   ┌─ API branch (steps 8'–13') ───────────┐
│ 8.  Run seed (tests/seed.spec.ts)│   │ 8'.  API Agent reads automate_api TCs  │
│ 9.  Playwright Planner → spec    │   │ 9'.  API Agent → collection json       │
│ 10. Gate 3 (specs review)        │   │ 10'. API Agent → environment json      │
│ 11. Playwright Generator → test  │   │ 11'. Gate 3' (collection review)       │
│ 12. Quality checks               │   │ 12'. Validate vs                       │
│ 13. Gate 4 (code review)         │   │      postman-collection.schema.json    │
│                                  │   │ 13'. Gate 4' (API assertion review)    │
└──────────────┬───────────────────┘   └──────────────────┬─────────────────────┘
               │                                           │
Step 14 (shared)  Execution
               │  npm run test                 (E2E → reports/results.json)
               │  STORY_ID=[id] npm run test:api (API → reports/newman-results.json)
               ▼
Steps 15–20 (shared)  Failure Classifier reads BOTH reports → one
                      analysis/failure-analysis.json. Reporter produces a
                      unified release-report with grouped execution_summary
                      { e2e, api, combined }.
Step 21    PHASE1.5-RETROSPECTIVE.md
```

### What is shared vs forked

| Stage                   | E2E branch                                        | API branch                           |
| ----------------------- | ------------------------------------------------- | ------------------------------------ |
| Story → context         | Analyst (shared)                                  | Analyst (shared)                     |
| Gate 1                  | shared                                            | shared                               |
| Test design             | Test Designer (shared)                            | Test Designer (shared)               |
| Gate 2                  | shared                                            | shared                               |
| Authoring               | Playwright Planner → spec; Generator → `.spec.ts` | API Agent → collection + environment |
| Specs/collection review | **Gate 3**                                        | **Gate 3'**                          |
| Code/assertion review   | **Gate 4** (permanent human)                      | **Gate 4'** (permanent human)        |
| Execution               | `npm run test` (Playwright)                       | `npm run test:api` (Newman)          |
| Classification          | Failure Classifier (shared, reads both reports)   | Failure Classifier (shared)          |
| Reporting               | Reporter (shared, grouped summary)                | Reporter (shared)                    |

The Failure Classifier and Reporter are **extended, not duplicated**
(Phase 1.5 TG5 + TG6). The schemas are **extended, not duplicated**
(Phase 1.5 TG3). The Healer never touches the API branch in any phase
(`docs/healer-guardrails.md`).

### Gate tracking for the API branch

The API-branch gates (3' and 4') are tracked the same way as the E2E
gates — as booleans in `context.json.review_gates`. Phase 1.5 may add
`collection_reviewed` and `api_assertions_reviewed` keys next to the
existing four; if so, that is a `schemas/context.schema.json` change and
follows the Architecture Stability Rule. Until those keys exist, a story
with both branches records the API-gate approvals alongside the run and
the human confirms both branches passed their gates before execution. See
`docs/review-gates.md` for the criteria.

---

## 6. Phase 2 — Integrations and CI

Phase 2 keeps the local flow intact and adds:

- `mcp-atlassian` switches from read-only to a writes-enabled allowlist
  (`ATLASSIAN_ENABLED_TOOLS_WRITE`), as a separate `atlassian-write`
  entry. Writes are never a side effect — see `docs/mcp-setup.md`.
- The TestLink XML-RPC sync (`scripts/sync-to-testlink.js`) pushes
  approved test cases and execution results to TestLink (the MCP bridge
  was dropped — see `docs/testlink-integration.md` and `ambiguities` A7).
- `scripts/create-jira-bugs.js` promotes Red bug drafts to real Jira
  issues — only when invoked with the `--apply` flag.
- Review audit fields (`reviewer`, `reviewed_at`, `notes`) added to
  `context.json.review_gates` as a backward-compatible `oneOf`, plus the
  optional `qa_scope_approved` consolidation gate (TG6 / TG7).
- GitHub Actions runs quality checks (required, blocking) plus
  Playwright / Newman jobs (informational until the suite is stable).

### 6.1 GitHub Actions CI (TG8)

The workflow is `.github/workflows/qa-pipeline.yml`. It triggers on PRs
to `main` / `develop` and on manual dispatch. Four jobs:

| Job               | Blocking?                           | What it does                                                                                                                             |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-checks`  | **Required / blocking**             | `npm ci`, then typecheck + lint + format check + `validate:all` (committed artifacts) + `validate:examples`. Fails the run on any error. |
| `playwright-full` | Informational (`continue-on-error`) | Installs browsers, runs `npm test`, uploads `reports/html` + `results.json` as an artifact.                                              |
| `newman-api`      | Informational (`continue-on-error`) | Runs Newman for each `api-tests/collections/*.json` (skipped if none), uploads the Newman report.                                        |
| `ci-summary`      | Always runs (`if: always()`)        | Downloads both report artifacts and runs `npm run ci:summary` to post a pass/fail table to the PR step summary.                          |

**Why `quality-checks` is always blocking.** It validates the contracts
the whole system rests on — schemas, types, lint, format. A PR that
breaks a schema or a type is broken regardless of whether a browser test
passed; this is the cheapest, most deterministic gate, so it guards
`main`.

**Why the test jobs are informational at first.** Generated E2E/API
suites stabilize over the first runs (flake, environment, timing). A
freshly generated suite that is occasionally red should not block every
unrelated PR. So `playwright-full` and `newman-api` carry
`continue-on-error: true` and are **not** listed as required checks in
branch protection. They still upload full reports as artifacts, and
`ci-summary` surfaces the tally on the PR.

**The no-contradiction rule.** A job is never "informational but
required". Either a job blocks (no `continue-on-error`, listed as a
required check) or it is informational (`continue-on-error: true`, not
required). The summary step likewise stays informational
(`scripts/ci-summary.js` exits 0 even on test failures) until the team
decides to promote the suite — at which point the smoke/full job drops
`continue-on-error`, becomes a required check, and `ci-summary` is run
with `--fail-on-test-failure`.

**When smoke / full becomes blocking.** Once a suite has run green
consistently (the team's call — typically after the suite stops flaking
across several PRs), promote it: remove `continue-on-error`, add it to
branch protection as a required check. Full suites usually graduate to
blocking later than a curated smoke subset.

**CI never writes outward.** No commits, no merges, no Jira/TestLink
writes, no Healer patches. Those are explicit local `--apply` operations
(`phase2-integrations.md` §3, `CLAUDE.md` §3.6). CI only reads, runs,
validates, and reports.

`scripts/ci-summary.js` is a mechanical pass/fail tally for the PR
surface — it does **not** replace `analysis/failure-analysis.json`,
which is the Failure Classifier Agent's classified, severity-bearing
output.

**Forbidden in Phase 1:** any of the above. See
`phase2-integrations.md` section 3.

---

## 7. Phase 3 — Healing, metrics, /evolve (Deferred)

Phase 3 adds:

- Rule-based Failure Classifier (LLM only on ambiguous cases).
- `scripts/run-healer.js` that generates `.patch` files for **Green**
  failures only — never commits, never merges, capped at 3 attempts.
- Healer CI job (assistive, never blocking, never committing).
- `agents/spec-reviewer.md` assists Gate 3 with a checklist; the human
  still decides.
- `runs/[story-id]/[run-id]/` history layout, with `scripts/new-run.js`.
- Pipeline metrics + `/evolve` loop for prompt evolution.
- Optional dual-judge framework evaluation.

**Forbidden in Phase 1:** any of the above. See
`phase3-healing-scaling.md` section 3.

---

## 8. Folder ownership at a glance

| Folder                         | Owner                                                            | Phase introduced |
| ------------------------------ | ---------------------------------------------------------------- | ---------------- |
| `docs/`, `schemas/`, `agents/` | Human / team                                                     | 1                |
| `skills/`                      | Human / team                                                     | 1                |
| `examples/`                    | Human / team                                                     | 1 (P2 extends)   |
| `scripts/`                     | Human / team                                                     | 1                |
| `test-cases/`                  | Test Designer Agent                                              | 1                |
| `planner-input/`               | Test Designer Agent                                              | 1                |
| `specs/`                       | Playwright Planner Native Agent                                  | 1                |
| `tests/`                       | Playwright Generator Native Agent + `tests/seed.spec.ts` (human) | 1                |
| `tests/fixtures/`              | Human / team                                                     | 1 (placeholder)  |
| `reports/`                     | Playwright runner / Newman                                       | 1 / 1.5          |
| `analysis/`                    | Failure Classifier Agent                                         | 1                |
| `release/`                     | Reporter Agent                                                   | 1                |
| `release/bug-drafts/`          | Failure Classifier / Reporter                                    | 1                |
| `api-tests/`                   | API Agent                                                        | **1.5**          |
| `analysis/spec-reviews/`       | Spec Reviewer Agent                                              | **3**            |
| `analysis/healer-validation/`  | Healer                                                           | **3**            |
| `release/healer-patches/`      | Healer                                                           | **3**            |
| `runs/`, `metrics/`            | `scripts/new-run.js` / metrics                                   | **3**            |
| `.github/workflows/`           | Human / team                                                     | **2**            |

Boundaries are enforced as a hard rule — see `docs/artifact-boundaries.md`
and `CLAUDE.md` section 3.2.

---

## 9. The contracts (schemas)

The pipeline's discipline rests on four JSON schemas that all artifacts
validate against. They are created in **Phase 1 TG7**. Once a schema is
in place, every artifact written to disk goes through `scripts/validate-json.js`
before it is considered done.

| Artifact                         | Schema                                   | Phase introduced |
| -------------------------------- | ---------------------------------------- | ---------------- |
| `context.json`                   | `schemas/context.schema.json`            | 1                |
| `test-cases/[story-id].json`     | `schemas/test-cases.schema.json`         | 1                |
| `analysis/failure-analysis.json` | `schemas/failure-analysis.schema.json`   | 1                |
| `release/release-report.json`    | `schemas/release-report.schema.json`     | 1                |
| `api-tests/collections/*.json`   | `schemas/postman-collection.schema.json` | **1.5**          |

When a schema changes, the **Architecture Stability Rule** applies:
`CLAUDE.md` section 3.10. Schema + every consuming agent prompt + relevant
docs + affected expected examples + a migration script (if non-backward-
compatible) all change in the same PR. Schemas are migrations, not edits.

### 9.1 The rule, formalized in CI (Phase 2 TG12)

The Architecture Stability Rule is also checked mechanically in CI by
`scripts/check-contract-changes.js`, run as the `contract-stability` job
in `.github/workflows/qa-pipeline.yml` (PRs only). It diffs the PR
against its base and, **if anything under `schemas/` changed**, checks
that the companion areas changed too:

- `agents/` — the prompts that produce/consume the artifact.
- `docs/` — the architecture / boundary docs.
- `examples/expected/` — the affected expected examples.

If any companion is missing, the job emits a GitHub `::warning::`
annotation on the PR naming what wasn't updated.

**It is a warning, not a gate.** A schema edit can be legitimately
standalone (e.g. a comment-only change), so the human decides whether
the warning matters; the job carries `continue-on-error: true` and the
script exits 0. The script accepts `--strict` (exit 1) so the team can
promote the check to blocking later, the same way the Playwright/Newman
jobs and `ci-summary` graduate from informational to required — see §6.1.
This deliberately does not try to verify _semantic_ completeness (that
the agent prompt actually reflects the new field); only a human review
can do that. The check catches the most common failure — forgetting a
companion file entirely — cheaply and early.

---

## 10. The MCPs

| MCP server        | Provides                                                                                                  | Phase introduced |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| `playwright-test` | The browser + test-runner MCP that the Playwright Native Agents call via `mcp__playwright-test__*` tools. | 1 (TG3)          |
| `atlassian`       | `sooperset/mcp-atlassian` — Jira + Confluence. **Read-only allowlist in Phase 1.**                        | 1 (TG4)          |
| `postman`         | `postmanlabs/postman-mcp-server` — collections + environments.                                            | **1.5**          |
| `testlink`        | `dogkeeper886/testlink-mcp` — TestLink XML-RPC.                                                           | **2**            |

Setup and verification live in `docs/mcp-setup.md`. The Phase 1
`ENABLED_TOOLS` allowlist is the policy: writes attempted by the agent
fail at the MCP layer, not at a policy check.

---

## 11. Pre-session checklist (for the IDE agent)

From `CLAUDE.md` section 7:

1. Read `CLAUDE.md` and the phase plan for the current phase.
2. State the Task Group you are about to execute.
3. If the work would change a schema: hold all the Architecture
   Stability Rule files together. If you can't, propose the change
   first; don't start.
4. If the work would cross a folder ownership boundary: stop and ask.
5. If the work would skip a gate, weaken a Healer guardrail, or
   introduce a forbidden dependency: stop and ask.

When in doubt: smaller steps, more validation, more stop-and-ask. The
system is designed to make rushing impossible.

---

## 12. Single sentence to remember

> **Reuse before building, validate before saving, stop before guessing.**
