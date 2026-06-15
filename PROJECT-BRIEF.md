# Project Brief — AI-Assisted QA Pipeline

> **Purpose of this document.** A complete, self-contained snapshot of the
> project at its current state, written so an external/improved AI model can
> evaluate _everything_ about it and propose improvements. It assumes **no prior
> context**: it restates what the system is, why it was built the way it was,
> every architectural decision, the full file inventory, what is done, what is
> deliberately _not_ done, the known weaknesses, and the open questions.
>
> **State as of writing:** all four phases complete; the project is in
> **continuous-improvement mode** (no Phase 4). Branch `docs/future-plans`;
> repo `MiltonKlun/AI-Assisted-QA`. Today: 2026-06-09.

---

## 1. One-paragraph summary

This is an **AI-assisted QA pipeline**: it takes a user story (from Jira via MCP,
or a manual `story.md`), runs it through a chain of **human-gated** steps, and
produces validated business test cases, Playwright E2E specs/tests, Postman/Newman
API checks, a classified failure analysis, a release report, and bug drafts that
can be promoted to Jira with explicit human approval. It is built by combining
mature open-source pieces (Playwright Native Agents, official MCPs for
Atlassian/Playwright/Postman/TestLink, skills adapted from
`dogkeeper886/ai-qa-workflow`) under a strict **discipline layer** (JSON Schemas +
AJV, traceability IDs, four human gates, folder ownership, an Architecture
Stability Rule). The stated goal was ~40–50% less custom code than building from
scratch, without losing quality guarantees.

**The core design stance:** it is _not_ an autonomous agent. A human drives each
step and approves four gates; Gate 4 (code review) is permanently human. The
system is deliberately engineered to "make rushing impossible."

---

## 2. The central tension this project must answer

The honest, unresolved question — and the most important thing for an evaluator to
weigh — is: **why use this ceremony instead of just asking an AI to do the same QA
job directly?**

The pipeline adds structure (schemas, gates, traceability, folder ownership,
versioned prompts) that a raw "write me Playwright tests for this story" prompt
does not. That structure buys **auditability, repeatability, traceability, and
guardrails against fictional/brittle tests**. It costs **setup, orchestration
friction, and per-story overhead**. The project has _documented_ this tension
(see `plan-poor-fit-improvements.md`) but has **not yet proven** the value
empirically, and has not yet removed the friction for small jobs. This is the
biggest strategic gap. See §10 and §11.

---

## 3. What the system produces (artifacts) and the traceability chain

Every artifact must locate itself in this chain:

```
JIRA-XXX (story) → RISK-001 → TC-001 → SPEC-001 → PW-001 → FAIL-001 → BUG-001
                            ↘ API-001 → COL-001 → REQ-001 → FAIL-001 → BUG-001
```

- **STORY/JIRA** — the user story (manual `story.md` or fetched from Jira).
- **RISK** — a product/business risk (written by the Analyst).
- **TC** — a business test case (Test Designer; references ≥1 risk).
- **SPEC** — a Playwright Planner markdown spec (references ≥1 TC).
- **PW** — a generated Playwright test (references SPEC + TC, in comments/metadata).
- **API / COL / REQ** — the parallel API branch (API test case → Postman collection → request).
- **FAIL** — an execution failure (references the PW/REQ test and its TC).
- **BUG** — a bug draft (references the failure, the TC, and the risk).

If a link genuinely can't be established, the artifact writes
`traceability_unresolved` with a reason. Faking links is forbidden.

---

## 4. The four human gates (the heart of the discipline)

| Gate                                    | When                                                | Human checks                                                                                                                   |
| --------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Gate 1 — Requirement Interpretation** | After Analyst                                       | ACs accurate, ambiguities explicit, risks meaningful, no invented business rules                                               |
| **Gate 2 — Test Scope Approval**        | After Test Designer                                 | Risk coverage, priorities, automation decisions justified, low-value cases marked `manual`/`skip`                              |
| **Gate 3 — Specs Review**               | After Playwright Planner / Postman collection ready | Specs match approved scope, negative cases present, no unrelated flows                                                         |
| **Gate 4 — Code Review**                | After Playwright Generator / final assertions       | Locators stable & semantic, assertions test real business behavior, code readable, no skipped tests, no unjustified hard waits |

- Gate 4 is **permanently human**; automating it is a forbidden change.
- Gates are recorded in `context.json` as booleans **or** audit objects
  `{status, reviewer, reviewed_at, notes}` (a `gateValue` `oneOf`).
- An optional `qa_scope_approved` can consolidate Gates 1+2 (used by the planned
  "lite" track).
- If a gate isn't `true`, the next agent must not run — stop and report.
- Gate **decisions** (approve/reject) are logged in `context.gate_decisions[]`,
  feeding the prompt-stability metric.

---

## 5. The agents

**Custom agents** (`agents/*.md`, human-authored prompts; they do not write outside their owned folders):

- `analyst.md` — reads the story, produces `context.json` (risks, ACs, ambiguities).
- `test-designer.md` — produces `test-cases/[story-id].json` + `planner-input/[story-id].planner-brief.md`, applying the Automation Decision Model. (v1.2.0)
- `api-agent.md` — produces `api-tests/collections/*.postman_collection.json` + environment.
- `failure-classifier.md` — produces `analysis/failure-analysis.json` + bug drafts; rule-based with LLM for ambiguous cases.
- `reporter.md` — produces `release/release-report.{md,json}`. (v1.2.0)
- `spec-reviewer.md` — assists Gate 3 with a checklist. (v1.2.0)
- `test-management-adapter.md` — the Open/Closed port for test management (testlink | jira | both | none).

All agent prompts are **versioned** (semver `version` + `changed_in_run` +
`changelog` frontmatter); `context.prompt_versions` maps which version produced a run.

**Playwright Native Agents** (`.claude/agents/`, generated by
`npx playwright init-agents --loop=claude`, never hand-edited):

- `planner` — explores the real app (via Playwright MCP) and writes a markdown spec.
- `generator` — turns a spec into a Playwright test file.
- `healer` — repairs failing tests within the Green/Yellow/Red guardrails.

**Adapted skills** (`skills/*/SKILL.md`, adapted from `dogkeeper886/ai-qa-workflow @ v3.0`):
`receiving-tickets`, `planning-tests`, `designing-cases`, `analyzing-logs`,
`syncing-testlink`, `syncing-jira`.

---

## 6. The Automation Decision Model

The Test Designer **must** classify each test case (marking everything E2E is
forbidden) and give a written reason (`automation_decision` +
`automation_decision_reason`):

| Decision             | When                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `automate_e2e`       | High-value user journeys, smoke/regression-critical, UI-critical flows                         |
| `automate_api`       | Business logic, validations, permissions, filtering, data-heavy checks without UI verification |
| `automate_component` | UI states below the E2E level (isolated components)                                            |
| `manual`             | Exploratory, usability, subjective/visual, accessibility judgment                              |
| `skip`               | Low-risk, duplicate, or out of scope                                                           |

Judgment note (from project memory): don't enforce a "push down from E2E" cap
mechanically — push to a lower seam when one genuinely exists, but 100% E2E is
acceptable when a story is genuinely all-UI.

---

## 7. The Healer guardrails (Green / Yellow / Red)

The Healer repairs **Playwright tests only** (never API/Newman), and **never
commits or merges** — every change is surfaced as a reviewable patch.

- **Green (auto-fix as reviewable patch):** broken locators/selectors, unstable
  waits, timeout stabilization, minor selector refactors preserving meaning.
- **Yellow (suggest only, human approval):** UI structural/layout/flow changes,
  new modal/page/navigation, behavior changed but possibly still valid.
- **Red (bug draft only, never auto-fix):** business-logic assertions,
  permission/role behavior, security validations, pricing/payment, compliance,
  data integrity, any assertion-meaning change.
- **Hard stops (always):** max 3 attempts per test; never change expected values;
  never delete a test; never add `.skip`/`.fixme`; never update snapshots without
  explicit approval; low confidence ⇒ `unknown_needs_human_review`.

These rules are enforced in code: `scripts/healer-guardrails.js` exports
`guardrailViolations(originalSource, patchedSource)`, imported by both
`run-healer.js` and the unit test (one source of truth). It rejects `.skip`/
`.fixme`, test deletion (test-count drop), assertion weakening
(`toBeTruthy`/`toBeDefined`/`.not.toThrow`), snapshot introduction, and
expected-value/literal changes (`toEqual`/`toBe`/`toHaveText`/`toHaveValue`/
`toHaveURL`/`toHaveCount`). `npm run demo:healer` proves Green (safe `[]`) vs Red
(rejected) deterministically.

---

## 8. The discipline layer (rules that never bend)

These are codified in `CLAUDE.md` §3 (operating instructions) and `README.md`:

1. **Work in small steps.** Each Task Group ships as its own branch → PR → green
   CI → merge, **one PR off `main` at a time** (anti-stacking discipline). >3
   failed attempts ⇒ stop and report.
2. **Folder ownership** (one owner per folder) — see the table in §9. Cross a
   boundary ⇒ stop and report.
3. **Validate every JSON artifact** against its schema immediately:
   `node scripts/validate-json.js schemas/<x>.schema.json <artifact>`. Exactly one
   generic validator; no per-schema validators; never bypass validation.
4. **Respect traceability IDs** (§3).
5. **Respect the four gates** (§4).
6. **Respect Healer guardrails** (§7).
7. **Do not invent requirements.** Ambiguities go to `context.json.ambiguities`
   (or `docs/ambiguities.md`) with `blocking: true|false`; then stop and ask.
8. **Do not generate tests from text alone.** The agent must open the real app via
   Playwright MCP and observe behavior before writing a spec/test. (For API: don't
   invent endpoint shapes — verify via Postman MCP or ask.) _This is described as
   the single most important rule for preventing brittle/fictional tests._
9. **Reuse before building** (official MCP > custom script; existing skill > new
   prompt; Native Agent > custom automation; AJV+Schema > custom validation;
   GitHub Actions > external orchestrator).
10. **Architecture Stability Rule** — a schema change is a migration: the same PR
    must update schema + every affected agent prompt + `docs/artifact-boundaries.md`
    - `docs/pipeline-architecture.md` (if structural) + affected
      `examples/expected/` + a `scripts/migrate-*.js` if old artifacts must stay
      valid. If you can't do all of it in one PR, don't change the schema.
11. **Stop conditions** — ambiguity blocks; writing outside ownership; skipping
    validation/gate; weakening a guardrail; committing/merging Healer changes;
    creating real Jira tickets without explicit `--apply`; new dependency not in
    the stack; introducing n8n/dashboard/DB/queue.

**One sentence to remember:** _Reuse before building, validate before saving, stop before guessing._

---

## 9. Folder ownership

| Path                                                                                     | Owner                      | Purpose                                        |
| ---------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| `docs/`, `schemas/`, `agents/`, `skills/`, `scripts/`, `examples/`, `.github/workflows/` | Human/team                 | Contracts, prompts, helpers, CI                |
| `test-cases/`                                                                            | Test Designer              | Business test cases JSON                       |
| `planner-input/`                                                                         | Test Designer              | Markdown brief for the Planner                 |
| `specs/`                                                                                 | Playwright Planner         | Specs markdown                                 |
| `tests/`                                                                                 | Playwright Generator       | Generated tests + `seed.spec.ts`               |
| `tests/fixtures/`                                                                        | Human/team                 | App-specific fixtures                          |
| `api-tests/{collections,environments}/`                                                  | API Agent                  | Postman collections + environments             |
| `reports/`                                                                               | Playwright Runner / Newman | Reports, traces, screenshots                   |
| `analysis/`                                                                              | Failure Classifier         | `failure-analysis.json`                        |
| `analysis/spec-reviews/`                                                                 | Spec Reviewer              | Gate 3 assist                                  |
| `analysis/healer-validation/`                                                            | Healer                     | Before/after patch validation                  |
| `release/`                                                                               | Reporter                   | Release report MD + JSON                       |
| `release/bug-drafts/`                                                                    | Classifier / Reporter      | `BUG-XXX.md` drafts                            |
| `release/healer-patches/`                                                                | Healer                     | `.patch` files (reviewable)                    |
| `runs/`                                                                                  | `new-run.js`               | Immutable per-run history (root = current run) |
| `metrics/`                                                                               | `pipeline-metrics.js`      | Pipeline metrics                               |

---

## 10. The stack (closed — anything else needs explicit approval)

**Runtime/tooling:** Node 20+ (CI on 20; dev on 22), TypeScript 5+ strict,
Playwright 1.56+ (1.60 installed) for Native Agents, ESLint v9 +
`eslint-plugin-playwright`, Prettier, AJV + `ajv-formats` (draft-07), Newman +
`newman-reporter-htmlextra`, Docker 20+ for container MCPs.

**MCPs (use official/adopted, never rewrite):**

- `ghcr.io/sooperset/mcp-atlassian:latest` (Jira+Confluence; read-only P1, write-enabled with `ENABLED_TOOLS` P2+).
- `microsoft/playwright-mcp` (via `npx playwright init-agents`).
- `postmanlabs/postman-mcp-server` (P1.5+).
- `dogkeeper886/testlink-mcp:latest` (P2+).

**Reference, not a runtime dep:** `dogkeeper886/ai-qa-workflow` (clone outside the
repo, copy & adapt skills; not a submodule).

**Explicitly forbidden:** n8n (decision documented), TestDino as a _required_ core
dep, QMetry hardcoded as test management (must stay adapter-friendly), custom
browser automation replacing Native Agents, custom MCPs where an official exists,
and DB/queue/web dashboard without approval.

**Key architectural decisions (with rationale, all in `README.md`):**

- **No n8n.** The automation lives inside the codebase, so Claude Code + GitHub
  Actions cover orchestration; n8n would add an external runtime, dual auth, and
  duplicated log storage. Reconsider only if the system grows cross-team
  notifications or non-technical workflow editing.
- **TestLink included** because its MCP is mature and the adapted skills already
  target it — but behind a `TestManagementAdapter` port (testlink | jira | both |
  none), so it's swappable.
- **API branch is mandatory**, built in Phase 1.5 parallel to E2E.

---

## 11. CI / automation posture

CI (`.github/workflows/qa-pipeline.yml`) deliberately separates blocking from
informational:

- **`quality-checks` — REQUIRED/blocking:** typecheck, lint, format check,
  `validate:all` (committed artifacts vs schemas), `validate:examples`,
  `test:unit` (Healer guardrails), `test:smoke` (script black-box). This is the
  gate that protects `main`.
- **`contract-stability` — informational:** warns if `schemas/` changed without
  the Architecture-Stability companions.
- **`prompt-eval` — informational:** when a PR touches `agents/`, runs the
  evaluation dataset and surfaces match %; a >10% drop vs baseline is the
  documented "needs rework" signal. Never edits prompts.
- **`playwright-full` — informational** (`continue-on-error`): a generated test
  can be legitimately red mid-development without blocking unrelated PRs.
- **`newman-api` — informational:** only runs if `api-tests/collections/` exist.
- **`healer` — informational, Green-only:** runs on PRs with real Playwright
  failures; posts a summary comment; **never pushes code**; in CI it generally
  can't run because there's no Gate-4-approved `context.json` (by design — the
  Healer is a local, post-Gate-4 assist).
- **`ci-summary` — always:** aggregates reports into the PR step summary.

**Hard rule:** CI never commits, merges, heals-to-main, or performs Jira/TestLink
writes. Writes are _only_ explicit local `--apply` operations ("writes are never a
side effect"). GitHub access is read-only. There is no autonomous batch across
stories.

**Two test layers (don't confuse them):**

- `test/` = the **pipeline's own** tests (node:test): `healer-guardrails.test.js`
  (10 unit tests of `guardrailViolations`) + `scripts-smoke.test.js` (9 black-box
  subprocess smoke tests). These gate `main`.
- `tests/` = the **generated product** Playwright tests, with a `@smoke`/
  `@regression` tag convention (`{ tag: ['@smoke'] }`, `--grep @smoke`). The
  graduation path to a blocking `playwright-smoke` job is documented but **not yet
  enabled** (gated on the suite proving stable across runs).

---

## 12. Continuous-improvement machinery

- **`/evolve`** (`scripts/evolve.js`) — the single compound loop: reads metrics +
  session-summaries + git, emits `evolve/evolve-proposal.md` with findings to
  accept/defer/reject. Already produced two high-confidence findings on real data
  (stacked-PRs, artifact-clobber). Cadence: every 90 days or 10 runs.
- **`session-summary.js`** — after each run, `npm run session-summary -- --friction "…"`
  captures friction so `/evolve` mines the highest-signal input.
- **`pipeline-metrics.js`** — every 5 runs; counts Gate 3/4 rejections from
  `gate_decisions[]`; computes `prompt_stability_met` once 10+ runs are logged.
- **Retrospectives:** `PHASE1` / `PHASE1.5` / `PHASE2` / `PHASE3-RETROSPECTIVE.md`
  record the build path; Phase 3 §10 defines the continuous-improvement cadence.
- **Prompt versioning** (`docs/prompt-versioning.md`) — semver + changelog per
  agent; CI evaluates on `agents/` changes.

---

## 13. Complete file inventory (what exists today)

**Root docs / plans:**
`README.md` (master index, Spanish), `CLAUDE.md` (operating instructions),
`phase1-foundation-e2e.md`, `phase1.5-api-branch.md`, `phase2-integrations.md`,
`phase3-healing-scaling.md`, the four `PHASE*-RETROSPECTIVE.md`,
`plan-compound-engineering.md` (planned, not started: CE-1..CE-6),
`plan-poor-fit-improvements.md` (planned, not started: PFI-1..PFI-6),
this `PROJECT-BRIEF.md`.

**`schemas/`** (draft-07): `context.schema.json` (incl. optional `prompt_versions`,
`gate_decisions[]`, and the `gateValue` oneOf), `test-cases.schema.json`,
`spec-review.schema.json`, `failure-analysis.schema.json`,
`postman-collection.schema.json`, `release-report.schema.json` (incl. optional
`summary_by_risk_level`, `untested_high_risk_items`, `flaky_tests`,
`open_bugs_summary`, `conditional_pass_criteria`, `external_links`).

**`agents/`:** analyst, test-designer, api-agent, failure-classifier, reporter,
spec-reviewer, test-management-adapter (all versioned).

**`skills/`:** receiving-tickets, planning-tests, designing-cases, analyzing-logs,
syncing-testlink, syncing-jira.

**`scripts/`:** `validate-json.js`, `validate-examples.js`, `validate-all.js`,
`check-contract-changes.js`, `ci-summary.js`, `evaluate-agents.js`,
`fetch-jira-story.js`, `export-to-jira.js`, `create-jira-bugs.js`,
`create-jira-testcases.js`, `sync-to-testlink.js`, `sync-testlink-execution.js`,
`run-newman.js`, `run-failure-classifier.js`, `run-healer.js`,
`healer-guardrails.js`, `demo-healer-green-red.js`, `pipeline-metrics.js`,
`evolve.js`, `session-summary.js`, `new-run.js`, `list-runs.js`, and migrations:
`migrate-context-v1-to-v2.js`, `migrate-testcases-external-ids.js`,
`migrate-release-report-tg12.js`, `migrate-context-gate-decisions.js`.

**`docs/`:** automation-decision-model, artifact-boundaries, healer-guardrails,
secrets-management, ambiguities, bug-draft-format, testlink-integration,
traceability, jira-export, mcp-setup, prompt-versioning, security-and-data-safety,
evolve-loop, dual-judge-evaluation (DEFERRED), context-json-guide, review-gates,
phase2-vertical-slice-runbook, test-designer, pipeline-architecture,
seed-test-guidelines, test-tagging, postman-integration.

**`tests/`:** `seed.spec.ts` (`@smoke`-tagged worked example).
**`test/`:** `healer-guardrails.test.js`, `scripts-smoke.test.js`.

**`package.json` scripts:** typecheck, lint(:fix), format:check/write, test,
test:e2e:smoke/regression, test:api, test:unit/smoke/pipeline, validate:_,
ci:summary, evaluate, fetch-story, export:jira, sync:jira-testcases, migrate:_,
new-run, list-runs, classify, heal, demo:healer, metrics, evolve, session-summary.

---

## 14. What is deliberately NOT built (and why)

- **No autonomous end-to-end run.** A human drives steps and approves four gates;
  Gate 4 is permanently human. This is foundational, not an oversight.
- **No one-command pipeline runner yet.** Orchestration is manual ("now run the
  next step"). A _thin gated runner_ that halts at every gate is planned (PFI-2)
  but not built.
- **No "lite" mode yet.** Every story currently goes through the full ceremony;
  a tiered `lite/standard/full` `track` field is planned (PFI-1) but not built.
- **No pluggable test runner.** The spine assumes Playwright + Newman; a
  `TestRunnerAdapter` (Cypress/k6/manual-only) is planned (PFI-4) but not built.
- **No pluggable story source / second CI provider** beyond Jira + manual +
  GitHub Actions (PFI-3 planned).
- **No front-of-loop ideate/brainstorm step.** The pipeline starts at a _story_;
  there's no "is this worth testing / what should we test first" step. Planned as
  own skills (CE-4), explicitly not via the CE plugin.
- **No dual-judge evaluation** (TG13 deferred with a re-evaluation trigger).
- **Compound Engineering plugin not installed** — the _frame_ is borrowed
  (`/evolve` ≈ `/ce-compound`, retrospectives ≈ pulse reports, `CLAUDE.md` ≈ taste
  extraction), but the plugin's Stage-5 autonomy endpoint is **explicitly
  rejected** as incompatible with the permanent human gate.
- **No n8n / DB / queue / web dashboard.**

---

## 15. Known weaknesses & open questions (for the evaluator to focus on)

Ordered by how much they affect "would a real QA actually choose this over raw AI."

1. **Unproven value loop.** The pipeline's benefit (auditability, non-brittle
   tests) is asserted, not yet demonstrated against a raw-AI baseline on real
   stories. There is no before/after evidence, no measured time-to-value.
2. **Per-story friction is high for routine work.** Full ceremony for a one-line
   bugfix is overkill. The lite track (PFI-1) and thin runner (PFI-2) are designed
   but unbuilt.
3. **No single entry point.** A newcomer can't run "the pipeline" — they must know
   the manual sequence. This is an adoption blocker.
4. **Stack lock-in.** Teams not on Playwright/Newman get little; the runner port
   (PFI-4) is the biggest architectural gap.
5. **Adoption ergonomics / "when to use" honesty.** No concise fit/don't-fit
   guide or à-la-carte one-pagers yet (PFI-6) — risk of misapplication and
   coworker resentment.
6. **Metrics not yet meaningful.** `prompt_stability_met` needs 10+ logged runs;
   the system likely hasn't accumulated enough real runs to validate its own
   improvement loop.
7. **Two-test-layer confusion** (`test/` vs `tests/`) is a recurring source of
   misunderstanding; documented but inherently subtle.
8. **Security hygiene depends on discipline.** `.env` is gitignored and must never
   be staged; writes are explicit `--apply` only. (Outstanding user task, not a
   repo issue: rotate API tokens that appeared in an earlier dev transcript.)

---

## 16. The two forward plans (already merged, not yet executed)

**`plan-poor-fit-improvements.md`** — make it lighter & more portable
(PFI-1 tiered track [schema change], PFI-2 thin gated runner, PFI-3 story-source +
CI ports, PFI-4 TestRunnerAdapter, PFI-5 sharper Gate 3/4 review assist, PFI-6
"when to use" + à-la-carte docs). **Cheap high-impact trio: PFI-1, PFI-5, PFI-6.**

**`plan-compound-engineering.md`** — borrow the CE frame without the plugin
(CE-1 eval/decision doc, CE-2 vocabulary map, CE-3 `STRATEGY.md` anchor, CE-4
ideate/brainstorm front-end, CE-5 reconcile a single compound loop, CE-6 gated
plugin re-eval). **Binding divergence: reject CE Stage-5 autonomy; keep Gate 4
human.**

Both follow the same discipline: one PR off `main`, schema changes trigger the
Architecture Stability Rule, prefer the adapter pattern, stop-and-ask before a new
dependency.

---

## 17. How to verify the system locally

```bash
npm ci
npm run typecheck && npm run lint && npm run format:check
npm run validate:all          # committed artifacts vs schemas
npm run validate:examples     # expected examples vs schemas
npm run test:unit             # Healer guardrails (10 tests)
npm run test:smoke            # scripts black-box (9 tests)
npm run demo:healer           # Green=safe vs Red=rejected, deterministic
npm run evaluate              # agent prompts vs evaluation dataset
npm run metrics               # pipeline metrics (needs logged runs to be meaningful)
```

A normal feature run is: Analyst → Gate 1 → Test Designer → Gate 2 → Planner →
Gate 3 → Generator → Gate 4 → execute → classify → report (see
`docs/phase2-vertical-slice-runbook.md`).

---

## 18. The single question to put to the improved model

> Given everything above, what should this project do — concretely and in priority
> order — to become a QA assistant that a working QA engineer (and their coworkers)
> would _choose_ over directly prompting an AI, **without** sacrificing the four
> human gates, traceability, schema validation, or the Healer guardrails that are
> its reason to exist?
